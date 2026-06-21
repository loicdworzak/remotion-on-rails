import express from 'express'
import { chromium } from 'playwright'
import ffmpegPath from 'ffmpeg-static'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
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

// ── Logging helpers ────────────────────────────────────────────────────────
let __renderCounter = 0
function makeLogger(prefix) {
  const start = Date.now()
  const id = prefix
  const elapsed = () => `${Date.now() - start}ms`
  return {
    id,
    start,
    log: (...args) => console.log(`[capture:${id}] +${elapsed()}`, ...args),
    warn: (...args) => console.warn(`[capture:${id}] +${elapsed()} ⚠️`, ...args),
    error: (...args) => console.error(`[capture:${id}] +${elapsed()} ❌`, ...args),
  }
}

console.log('========================================')
console.log('[capture] BOOTING capture worker')
console.log('[capture] PORT           =', PORT)
console.log('[capture] TOKEN set?     =', Boolean(TOKEN))
console.log('[capture] WIDTH x HEIGHT =', WIDTH, 'x', HEIGHT)
console.log('[capture] FPS            =', FPS)
console.log('[capture] SCALE          =', SCALE)
console.log('[capture] CRF            =', CRF)
console.log('[capture] DEFAULT_BASE_URL =', DEFAULT_BASE_URL || '(none — baseUrl required per request)')
console.log('[capture] OUTPUT_DIR     =', OUTPUT_DIR)
console.log('[capture] ffmpegPath     =', ffmpegPath)
console.log('========================================')

const app = express()
app.use(express.json({ limit: '2mb' }))

// Log every incoming request at the top, before auth/routing.
app.use((req, _res, next) => {
  // Don't dump the raw token to logs in full — show a truncated version so
  // you can still match it to a job without leaking the whole secret.
  const safeBody = { ...(req.body || {}) }
  if (safeBody.token) safeBody.token = `${String(safeBody.token).slice(0, 8)}...`
  console.log(`[http] ${new Date().toISOString()} ${req.method} ${req.originalUrl} body=${JSON.stringify(safeBody)}`)
  next()
})

// ── Optional bearer auth ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (!TOKEN) {
    console.log('[auth] no CAPTURE_TOKEN configured — skipping auth check')
    return next()
  }
  const auth = req.headers.authorization || ''
  if (auth === `Bearer ${TOKEN}`) {
    console.log('[auth] OK')
    return next()
  }
  console.warn('[auth] ❌ Unauthorized request — got header:', auth ? `"${auth.slice(0, 12)}..."` : '(none)')
  res.status(401).json({ error: 'Unauthorized' })
})

app.get('/health', (_req, res) => {
  console.log('[health] OK ping')
  res.json({ ok: true })
})

// ── Build the /capture URL the page expects ───────────────────────────────────
// THE APP'S REAL CONTRACT (confirmed by reading /api/render-capture):
//   POST /render { baseUrl, jobId, token }
// The /capture page loads the flow + sequence from the DB via the time-limited
// job token — projectId/flowId are NEVER part of this path. The job route
// builds: ${baseUrl}/capture?jobId=<jobId>&token=<token>
//
// We still accept { url } (a full public/job link, verbatim) and
// { projectId, flowId, seq, theme, duration } as a secondary convenience for
// manual/public-link testing, but jobId+token is the PRIMARY, expected path.
function buildCaptureUrl({ baseUrl, url, jobId, token, projectId, flowId, seq, theme, duration }, log) {
  log.log('buildCaptureUrl() input =', {
    baseUrl, url, jobId, token: token ? `${String(token).slice(0, 8)}...` : token,
    projectId, flowId, seq, theme, duration,
  })

  if (url) {
    log.log('buildCaptureUrl() → caller passed full url verbatim:', url)
    return url
  }

  const origin = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
  log.log('buildCaptureUrl() resolved origin =', origin || '(EMPTY)')

  if (!origin) {
    log.error('buildCaptureUrl() → Missing baseUrl AND no CAPTURE_BASE_URL set')
    throw new Error('Missing baseUrl (and no CAPTURE_BASE_URL set)')
  }

  // ── PRIMARY PATH: secure render job (this is what "Render MP4" sends) ──────
  if (jobId && token) {
    const qs = new URLSearchParams({ jobId, token })
    const finalUrl = `${origin}/capture?${qs.toString()}`
    log.log('buildCaptureUrl() → using PRIMARY job path (jobId/token). Built URL:', finalUrl.replace(token, `${token.slice(0, 8)}...`))
    return finalUrl
  }

  // ── FALLBACK PATH: public link by ids (manual testing / public share link) ─
  if (projectId && flowId) {
    const qs = new URLSearchParams({ projectId, flowId })
    if (seq)      qs.set('seq', seq)
    if (theme)    qs.set('theme', theme)
    if (duration) qs.set('duration', String(duration))
    const finalUrl = `${origin}/capture?${qs.toString()}`
    log.log('buildCaptureUrl() → using FALLBACK public-link path (projectId/flowId). Built URL:', finalUrl)
    return finalUrl
  }

  log.error('buildCaptureUrl() → Missing jobId/token (and no projectId/flowId, and no url)')
  throw new Error('Missing jobId/token (or projectId/flowId, or url)')
}

// ── POST /render — kick off a background render, return the fileName now ──────
app.post('/render', async (req, res) => {
  __renderCounter += 1
  const renderId = `r${__renderCounter}-${Date.now()}`
  const log = makeLogger(renderId)

  const safeBody = { ...(req.body || {}) }
  if (safeBody.token) safeBody.token = `${String(safeBody.token).slice(0, 8)}...`
  log.log('POST /render received. body =', JSON.stringify(safeBody))

  const { baseUrl, url, jobId, token, projectId, flowId, seq, theme, duration } = req.body || {}

  let captureUrl
  try {
    captureUrl = buildCaptureUrl({ baseUrl, url, jobId, token, projectId, flowId, seq, theme, duration }, log)
  } catch (err) {
    log.error('buildCaptureUrl failed:', err.message)
    return res.status(400).json({ error: err.message })
  }

  const fileName = `nemo-${Date.now()}.mp4`
  const outPath  = path.join(OUTPUT_DIR, fileName)

  log.log('fileName =', fileName)
  log.log('outPath  =', outPath)
  log.log('Kicking off renderCapture() in background...')

  // Render in the background; the app polls GET /download/:fileName.
  renderCapture({ captureUrl, fallbackDurationMs: Number(duration) || undefined, outPath, log })
    .then(() => {
      log.log('✅ renderCapture() completed successfully. Total time:', `${Date.now() - log.start}ms`)
      try {
        const stat = statSync(outPath)
        log.log('Output file size:', stat.size, 'bytes')
      } catch (statErr) {
        log.warn('Could not stat output file after completion:', statErr.message)
      }
    })
    .catch((err) => {
      log.error('renderCapture() FAILED:', err?.message || err)
      log.error('Stack trace:', err?.stack || '(no stack)')
    })

  log.log('Responding 202 to caller immediately (render continues async)')
  return res.status(202).json({ fileName })
})

// ── GET /download/:fileName ──────────────────────────────────────────────────
app.get('/download/:fileName', async (req, res) => {
  const fileName = path.basename(req.params.fileName)
  const filePath = path.join(OUTPUT_DIR, fileName)
  console.log(`[download] requested fileName=${fileName} → filePath=${filePath}`)

  if (!existsSync(filePath)) {
    console.warn(`[download] ⚠️ Not ready / not found: ${filePath}`)
    return res.status(404).json({ error: 'Not ready' })
  }

  try {
    const stat = statSync(filePath)
    console.log(`[download] found file, size=${stat.size} bytes — sending...`)
  } catch (e) {
    console.warn('[download] could not stat file before sending:', e.message)
  }

  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error(`[download] ❌ error sending file ${filePath}:`, err.message)
    } else {
      console.log(`[download] ✅ sent file ${filePath}`)
    }
  })
})

// ── Core: frame-by-frame capture of the real /capture page ───────────────────
async function renderCapture({ captureUrl, fallbackDurationMs, outPath, log }) {
  log.log('renderCapture() START')
  log.log('  captureUrl          =', captureUrl)
  log.log('  fallbackDurationMs  =', fallbackDurationMs)
  log.log('  outPath             =', outPath)

  log.log('Ensuring OUTPUT_DIR exists:', OUTPUT_DIR)
  await mkdir(OUTPUT_DIR, { recursive: true })
  log.log('OUTPUT_DIR ready')

  log.log('Launching Chromium (headless)...')
  const browserLaunchStart = Date.now()
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  })
  log.log(`Chromium launched in ${Date.now() - browserLaunchStart}ms`)

  browser.on('disconnected', () => log.error('Browser DISCONNECTED unexpectedly'))

  try {
    log.log('Creating browser context. viewport =', { width: WIDTH, height: HEIGHT }, 'deviceScaleFactor =', SCALE)
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: SCALE,
    })
    log.log('Context created')

    await context.addInitScript(() => {
      window.__nemoCaptureDriven = true
    })
    log.log('Init script injected: window.__nemoCaptureDriven = true')

    log.log('Opening new page...')
    const page = await context.newPage()
    log.log('Page created')

    // Pipe ALL browser-side console output back to our logs.
    page.on('console', (msg) => {
      log.log(`[page console:${msg.type()}]`, msg.text())
    })
    page.on('pageerror', (err) => {
      log.error('[page pageerror]', err.message)
    })
    page.on('requestfailed', (request) => {
      log.error('[page requestfailed]', request.method(), request.url(), '→', request.failure()?.errorText)
    })
    page.on('response', (response) => {
      const status = response.status()
      if (status >= 400) {
        log.warn('[page response]', status, response.url())
      } else {
        log.log('[page response]', status, response.url())
      }
    })
    page.on('crash', () => {
      log.error('[page] PAGE CRASHED')
    })
    page.on('close', () => {
      log.log('[page] page closed')
    })
    log.log('Page event listeners attached (console, pageerror, requestfailed, response, crash, close)')

    log.log('Installing virtual clock at time=0...')
    await page.clock.install({ time: 0 })
    log.log('Virtual clock installed')

    log.log('Navigating to captureUrl (waitUntil=load, timeout=45000ms)...')
    const navStart = Date.now()
    try {
      await page.goto(captureUrl, { waitUntil: 'load', timeout: 45_000 })
      log.log(`Navigation completed in ${Date.now() - navStart}ms`)
    } catch (navErr) {
      log.error(`Navigation FAILED after ${Date.now() - navStart}ms:`, navErr.message)
      throw navErr
    }

    log.log('Running virtual clock forward 1300ms to let scene mount + settle timer fire...')
    await page.clock.runFor(1300)
    log.log('Clock advanced 1300ms')

    log.log('Checking window.__nemoCaptureError ...')
    const captureError = await page.evaluate(() => window.__nemoCaptureError || null)
    if (captureError) {
      // Most common real-world cause here: expired/invalid job token.
      log.error('Page reported __nemoCaptureError:', captureError, '(check: expired or invalid jobId/token?)')
      throw new Error(`Capture page error: ${captureError}`)
    }
    log.log('No __nemoCaptureError reported (yet)')

    log.log('Waiting for window.__nemoCaptureReady === true (timeout=30000ms)...')
    const readyStart = Date.now()
    try {
      await page.waitForFunction(() => window.__nemoCaptureReady === true, { timeout: 30_000 })
      log.log(`__nemoCaptureReady became true after ${Date.now() - readyStart}ms`)
    } catch (readyErr) {
      log.error(`Timed out waiting for __nemoCaptureReady after ${Date.now() - readyStart}ms:`, readyErr.message)
      try {
        const diag = await page.evaluate(() => ({
          ready: window.__nemoCaptureReady,
          error: window.__nemoCaptureError,
          driven: window.__nemoCaptureDriven,
          durationMs: window.__nemoCaptureDurationMs,
          readyState: document.readyState,
          bodyHTMLLength: document.body ? document.body.innerHTML.length : -1,
        }))
        log.error('Diagnostic page state at timeout:', JSON.stringify(diag))
      } catch (diagErr) {
        log.error('Could not even evaluate diagnostic state:', diagErr.message)
      }
      try {
        const debugPng = await page.screenshot({ type: 'png' })
        log.error('Captured a debug screenshot at timeout, size =', debugPng.length, 'bytes')
      } catch (shotErr) {
        log.error('Could not even take a debug screenshot:', shotErr.message)
      }
      throw readyErr
    }

    log.log('Reading window.__nemoCaptureDurationMs ...')
    const reportedDurationMs = await page.evaluate(() => window.__nemoCaptureDurationMs)
    log.log('  reportedDurationMs =', reportedDurationMs)
    log.log('  fallbackDurationMs =', fallbackDurationMs)
    const durationMs = reportedDurationMs || fallbackDurationMs || 20_000
    log.log('  → using durationMs =', durationMs, reportedDurationMs ? '(from page)' : (fallbackDurationMs ? '(from fallback param)' : '(hardcoded default 20000)'))

    const frameMs     = 1000 / FPS
    const totalFrames = Math.round((durationMs / 1000) * FPS) + 1
    log.log('  frameMs     =', frameMs)
    log.log('  totalFrames =', totalFrames)

    log.log('Calling window.__nemoCaptureStart() to begin playback...')
    const startFnExists = await page.evaluate(() => typeof window.__nemoCaptureStart === 'function')
    log.log('  window.__nemoCaptureStart is a function?', startFnExists)
    if (!startFnExists) {
      log.warn('  ⚠️ __nemoCaptureStart is NOT defined on the page — playback will likely never advance!')
    }
    await page.evaluate(() => window.__nemoCaptureStart && window.__nemoCaptureStart())
    log.log('__nemoCaptureStart() invoked')

    log.log('Spawning ffmpeg process → output:', outPath)
    const ff = spawnFfmpeg(outPath, log)

    log.log(`Starting frame capture loop: ${totalFrames} frames @ ${FPS}fps (${durationMs}ms)`)
    let advancedMs = 0
    const loopStart = Date.now()
    let lastLogAt = 0

    for (let i = 0; i < totalFrames; i++) {
      const targetMs = Math.round(i * frameMs)
      const step = targetMs - advancedMs
      advancedMs = targetMs

      if (step > 0) {
        await page.clock.runFor(step)
      }

      const frameStart = Date.now()
      const png = await page.screenshot({ type: 'png' })
      const frameElapsed = Date.now() - frameStart

      if (i % 30 === 0 || frameElapsed > 500) {
        log.log(`  frame ${i + 1}/${totalFrames} | targetMs=${targetMs} | screenshot took ${frameElapsed}ms | bytes=${png.length}`)
      }
      if (frameElapsed > 2000) {
        log.warn(`  frame ${i + 1}/${totalFrames} took ${frameElapsed}ms — unusually slow, possible page hang/heavy repaint`)
      }

      const canWrite = ff.stdin.write(png)
      if (!canWrite) {
        const drainStart = Date.now()
        log.log(`  ffmpeg stdin backpressure at frame ${i + 1} — waiting for drain...`)
        await new Promise((resolve) => ff.stdin.once('drain', resolve))
        log.log(`  drained after ${Date.now() - drainStart}ms`)
      }

      if (Date.now() - lastLogAt > 5000) {
        log.log(`  ...heartbeat: frame ${i + 1}/${totalFrames}, elapsed ${Date.now() - loopStart}ms total`)
        lastLogAt = Date.now()
      }
    }

    log.log(`Frame capture loop finished. Total loop time: ${Date.now() - loopStart}ms`)
    log.log('Closing ffmpeg stdin (signals end of stream)...')
    ff.stdin.end()
    log.log('Waiting for ffmpeg to finish encoding...')
    const ffStart = Date.now()
    await ff.done
    log.log(`ffmpeg finished encoding in ${Date.now() - ffStart}ms`)
  } catch (err) {
    log.error('renderCapture() threw:', err?.message || err)
    throw err
  } finally {
    log.log('Closing browser...')
    const closeStart = Date.now()
    await browser.close().catch((closeErr) => {
      log.warn('Error while closing browser (ignored):', closeErr.message)
    })
    log.log(`Browser closed in ${Date.now() - closeStart}ms`)
    log.log('renderCapture() END')
  }
}

// ── ffmpeg: assemble a stream of PNG frames (stdin) into an H.264 MP4 ─────────
function spawnFfmpeg(output, log) {
  const args = [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(FPS),
    '-i', 'pipe:0',
    '-vf', `scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', CRF,
    '-tune', 'animation',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  ]
  log.log('spawnFfmpeg() args:', args.join(' '))
  const ff = spawn(ffmpegPath, args)

  ff.on('spawn', () => log.log('ffmpeg process spawned, pid =', ff.pid))
  ff.on('error', (err) => log.error('ffmpeg process error event:', err.message))

  let stderr = ''
  ff.stderr.on('data', (d) => {
    const chunk = d.toString()
    stderr += chunk
    log.log('[ffmpeg stderr]', chunk.trim())
  })
  ff.stdin.on('error', (err) => {
    log.error('ffmpeg stdin error:', err.message)
  })

  const done = new Promise((resolve, reject) => {
    ff.on('error', reject)
    ff.on('close', (code, signal) => {
      log.log(`ffmpeg process closed. code=${code} signal=${signal}`)
      if (code === 0) {
        resolve(output)
      } else {
        log.error('ffmpeg failed. Last stderr output:', stderr.slice(-1500))
        reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-800)}`))
      }
    })
  })
  return { stdin: ff.stdin, done }
}

app.listen(PORT, () => {
  console.log(`[capture] frame-by-frame worker listening on :${PORT}`)
  console.log(`[capture] output dir: ${OUTPUT_DIR} | ${WIDTH}x${HEIGHT}@${FPS} scale=${SCALE} crf=${CRF}`)
})
