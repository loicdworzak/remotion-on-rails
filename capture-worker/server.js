import express from 'express'
import { chromium } from 'playwright'
import ffmpegPath from 'ffmpeg-static'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PORT   = process.env.PORT || 8080
const TOKEN  = process.env.CAPTURE_TOKEN
const WIDTH  = Number(process.env.CAPTURE_WIDTH  || 1920)
const HEIGHT = Number(process.env.CAPTURE_HEIGHT || 1080)
const FPS    = Number(process.env.CAPTURE_FPS    || 30)
const SCALE  = Number(process.env.CAPTURE_SCALE  || 2)
const CRF    = String(process.env.CAPTURE_CRF    || 16)

// Default app origin so callers can omit baseUrl (e.g. your Vercel deployment).
const DEFAULT_BASE_URL = process.env.CAPTURE_BASE_URL || ''
const OUTPUT_DIR = process.env.CAPTURE_OUTPUT_DIR || path.join(tmpdir(), 'nemo-captures')

const app = express()
app.use(express.json({ limit: '2mb' })) // payload is tiny now — just ids + params

// ── Optional bearer auth ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (!TOKEN) return next()
  const auth = req.headers.authorization || ''
  if (auth === `Bearer ${TOKEN}`) return next()
  res.status(401).json({ error: 'Unauthorized' })
})

app.get('/health', (_req, res) => res.json({ ok: true }))

// ── Build the public /capture URL the page expects ────────────────────────────
// The page is self-contained: it loads the flow from /api/public/flow using
// projectId + flowId, applies `theme`, and exposes the __nemoCapture* flags.
function buildCaptureUrl({ baseUrl, url, projectId, flowId, seq, theme, duration }) {
  if (url) return url // caller passed a full public link verbatim
  const origin = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
  if (!origin) throw new Error('Missing baseUrl (and no CAPTURE_BASE_URL set)')
  if (!projectId || !flowId) throw new Error('Missing projectId or flowId')
  const qs = new URLSearchParams({ projectId, flowId })
  if (seq)      qs.set('seq', seq)
  if (theme)    qs.set('theme', theme)
  if (duration) qs.set('duration', String(duration))
  return `${origin}/capture?${qs.toString()}`
}

// ── POST /render — kick off a background render, return the fileName now ──────
app.post('/render', async (req, res) => {
  const { baseUrl, url, projectId, flowId, seq, theme, duration } = req.body || {}

  let captureUrl
  try {
    captureUrl = buildCaptureUrl({ baseUrl, url, projectId, flowId, seq, theme, duration })
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }

  const fileName = `nemo-${Date.now()}.mp4`
  const outPath  = path.join(OUTPUT_DIR, fileName)

  // Render in the background; the app polls GET /download/:fileName.
  renderCapture({ captureUrl, fallbackDurationMs: Number(duration) || undefined, outPath })
    .catch((err) => console.error('[capture] render failed:', err?.message || err))

  return res.status(202).json({ fileName, captureUrl })
})

// ── GET /download/:fileName ──────────────────────────────────────────────────
app.get('/download/:fileName', async (req, res) => {
  const fileName = path.basename(req.params.fileName)
  const filePath = path.join(OUTPUT_DIR, fileName)
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Not ready' })
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
  res.sendFile(filePath)
})

// ── Core: frame-by-frame capture of the real /capture page ───────────────────
async function renderCapture({ captureUrl, fallbackDurationMs, outPath }) {
  await mkdir(OUTPUT_DIR, { recursive: true })

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  })

  try {
    // Supersample: render the page at SCALE× device pixels, then downscale in
    // ffmpeg → crisp text + smooth gradients.
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: SCALE,
    })

    // Flag driven-mode BEFORE any page script runs, so the /capture page does
    // NOT auto-play — we drive it under the virtual clock. The flow + sequence
    // are loaded by the page itself from the URL (no sessionStorage injection).
    await context.addInitScript(() => {
      window.__nemoCaptureDriven = true
    })

    const page = await context.newPage()

    // Virtual clock: controls Date, setTimeout, setInterval, performance.now()
    // and requestAnimationFrame. Advancing it steps the playback loop AND the
    // camera transitions deterministically, one frame at a time.
    await page.clock.install({ time: 0 })

    await page.goto(captureUrl, { waitUntil: 'load', timeout: 45_000 })

    // Let the scene mount + fire its settle timer (sets ready). Driven mode
    // means it will NOT auto-play.
    await page.clock.runFor(1300)

    // Fail fast if the page reported a load error (bad ids, no sequence, …).
    const captureError = await page.evaluate(() => window.__nemoCaptureError || null)
    if (captureError) throw new Error(`Capture page error: ${captureError}`)

    await page.waitForFunction(() => window.__nemoCaptureReady === true, { timeout: 30_000 })

    const durationMs =
      (await page.evaluate(() => window.__nemoCaptureDurationMs)) ||
      fallbackDurationMs ||
      20_000

    const frameMs     = 1000 / FPS
    const totalFrames = Math.round((durationMs / 1000) * FPS) + 1

    // Start playback (seek 0 + play) — schedules the first rAF tick.
    await page.evaluate(() => window.__nemoCaptureStart && window.__nemoCaptureStart())

    const ff = spawnFfmpeg(outPath)

    let advancedMs = 0
    for (let i = 0; i < totalFrames; i++) {
      // Advance the clock to this frame's timestamp using integer steps to
      // avoid sub-ms drift, then fire the pending rAF tick.
      const targetMs = Math.round(i * frameMs)
      const step = targetMs - advancedMs
      advancedMs = targetMs
      if (step > 0) await page.clock.runFor(step)

      const png = await page.screenshot({ type: 'png' })
      if (!ff.stdin.write(png)) {
        await new Promise((resolve) => ff.stdin.once('drain', resolve))
      }
    }

    ff.stdin.end()
    await ff.done
  } finally {
    await browser.close().catch(() => {})
  }
}

// ── ffmpeg: assemble a stream of PNG frames (stdin) into an H.264 MP4 ─────────
function spawnFfmpeg(output) {
  const args = [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(FPS),
    '-i', 'pipe:0',
    // Downscale the supersampled frames to output size, then 8-bit yuv420p.
    '-vf', `scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', CRF,
    '-tune', 'animation', // flat-color UI / gradients
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  ]
  const ff = spawn(ffmpegPath, args)
  let stderr = ''
  ff.stderr.on('data', (d) => { stderr += d.toString() })
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject)
    ff.on('close', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-800)}`))
    })
  })
  return { stdin: ff.stdin, done }
}

app.listen(PORT, () => {
  console.log(`[capture] frame-by-frame worker listening on :${PORT}`)
  console.log(`[capture] output dir: ${OUTPUT_DIR} | ${WIDTH}x${HEIGHT}@${FPS} scale=${SCALE} crf=${CRF}`)
})
