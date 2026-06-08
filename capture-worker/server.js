/**
 * Nemo capture worker — pixel-perfect MP4 via real-page screen recording.
 */

import express from 'express'
import { chromium } from 'playwright'
import ffmpegPath from 'ffmpeg-static'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PORT = process.env.PORT || 8080
const TOKEN = process.env.CAPTURE_TOKEN
const WIDTH = Number(process.env.CAPTURE_WIDTH || 1280)
const HEIGHT = Number(process.env.CAPTURE_HEIGHT || 720)
const FPS = Number(process.env.CAPTURE_FPS || 30)

const OUTPUT_DIR = process.env.CAPTURE_OUTPUT_DIR || path.join(tmpdir(), 'nemo-captures')

const app = express()
app.use(express.json({ limit: '25mb' }))

app.use((req, res, next) => {
  if (!TOKEN) return next()
  const auth = req.headers.authorization || ''
  if (auth === `Bearer ${TOKEN}`) return next()
  res.status(401).json({ error: 'Unauthorized' })
})

app.get('/health', (_req, res) => res.json({ ok: true }))

app.post('/render', async (req, res) => {
  const { baseUrl, flowJson, sequenceJson } = req.body || {}
  if (!baseUrl || !flowJson) {
    return res.status(400).json({ error: 'Missing baseUrl or flowJson' })
  }
  const fileName = `nemo-${Date.now()}.mp4`
  const outPath = path.join(OUTPUT_DIR, fileName)
  try {
    await renderCapture({ baseUrl, flowJson, sequenceJson, outPath })
    return res.json({ fileName })
  } catch (err) {
    console.error('[capture] render failed:', err)
    return res.status(500).json({ error: err?.message || String(err) })
  }
})

app.get('/download/:fileName', async (req, res) => {
  const fileName = path.basename(req.params.fileName)
  const filePath = path.join(OUTPUT_DIR, fileName)
  if (!existsSync(filePath)) return res.status(404).json({ error: 'Not ready' })
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
  res.sendFile(filePath)
})

async function renderCapture({ baseUrl, flowJson, sequenceJson, outPath }) {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(OUTPUT_DIR, { recursive: true })
  const videoDir = await mkdtemp(path.join(tmpdir(), 'nemo-vid-'))

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-frame-rate-limit',
      '--force-device-scale-factor=1',
    ],
  })

  try {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      recordVideo: { dir: videoDir, size: { width: WIDTH, height: HEIGHT } },
    })

    await context.addInitScript(
      ({ flow, seq }) => {
        sessionStorage.setItem('nemo_capture_flow', flow)
        if (seq) sessionStorage.setItem('nemo_capture_sequence', seq)
      },
      { flow: flowJson, seq: sequenceJson || null },
    )

    const page = await context.newPage()
    const url = `${baseUrl.replace(/\/$/, '')}/capture`
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 })

    const captureError = await page.evaluate(() => window.__nemoCaptureError || null)
    if (captureError) throw new Error(`Capture page error: ${captureError}`)

    await page.waitForFunction(() => window.__nemoCaptureReady === true, { timeout: 30000 })

    const durationMs = await page.evaluate(() => window.__nemoCaptureDurationMs || 20000)

    await page.waitForFunction(() => window.__nemoCaptureDone === true, {
      timeout: durationMs + 15000,
    })

    await context.close()

    const webmPath = await findNewestWebm(videoDir)
    if (!webmPath) throw new Error('No video file was produced by Playwright')

    await transcodeToMp4(webmPath, outPath)
  } finally {
    await browser.close().catch(() => {})
    await rm(videoDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function findNewestWebm(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.webm'))
  if (files.length === 0) return null
  let newest = null
  let newestMtime = 0
  for (const f of files) {
    const full = path.join(dir, f)
    const s = await stat(full)
    if (s.mtimeMs >= newestMtime) {
      newestMtime = s.mtimeMs
      newest = full
    }
  }
  return newest
}

function transcodeToMp4(input, output) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', input,
      '-r', String(FPS),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      output,
    ]
    const ff = spawn(ffmpegPath, args)
    let stderr = ''
    ff.stderr.on('data', (d) => { stderr += d.toString() })
    ff.on('error', reject)
    ff.on('close', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(-500)}`))
    })
  })
}

app.listen(PORT, () => {
  console.log(`[capture] worker listening on :${PORT}`)
  console.log(`[capture] output dir: ${OUTPUT_DIR}`)
})
