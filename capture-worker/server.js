// ─────────────────────────────────────────────────────────────────────────
// HIGH-QUALITY CHROMIUM SCREEN CAPTURE — pure Chrome DevTools Protocol.
// NO Playwright, NO Puppeteer. We launch Chromium ourselves (chrome-launcher)
// and talk to it directly over CDP (chrome-remote-interface).
//
// Why: Playwright's recordVideo() encodes a low-bitrate WebM internally —
// we have zero control over quality. Here we use Page.startScreencast with
// PNG frames at quality 100 (lossless), capturing the REAL compositor output
// every time it actually repaints (event-driven, not a fixed polling loop),
// then assemble those frames into an mp4 with ffmpeg at a high bitrate/CRF
// that we fully control.
// ─────────────────────────────────────────────────────────────────────────

import express from 'express'
import ffmpegPath from 'ffmpeg-static'
import { spawn } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as chromeLauncher from 'chrome-launcher'
import CDP from 'chrome-remote-interface'

const PORT   = process.env.PORT || 8080
const TOKEN  = process.env.CAPTURE_TOKEN
const WIDTH  = Number(process.env.CAPTURE_WIDTH  || 1920)
const HEIGHT = Number(process.env.CAPTURE_HEIGHT || 1080)
const SCALE  = Number(process.env.CAPTURE_SCALE  || 2)   // device pixel ratio (supersampling)
const CRF    = String(process.env.CAPTURE_CRF    || 14)  // lower = higher quality. 14 is visually near-lossless.
const FPS_OUT = Number(process.env.CAPTURE_FPS   || 30)  // output container frame rate

// chrome-launcher needs a real Chrome/Chromium binary path. On Railway you
// likely already have one (from whatever base image / apt install you used).
// Set CHROME_PATH explicitly to avoid relying on auto-detection.
const CHROME_PATH = process.env.CHROME_PATH || process.env.CHROMIUM_PATH || undefined

const DEFAULT_BASE_URL = process.env.CAPTURE_BASE_URL || ''
const OUTPUT_DIR = process.env.CAPTURE_OUTPUT_DIR || path.join(tmpdir(), 'nemo-captures')
const TMP_DIR = path.join(OUTPUT_DIR, '_tmp')

// ── Logging ──────────────────────────────────────────────────────────────
let __renderCounter = 0
function makeLogger(prefix) {
  const start = Date.now()
  const elapsed = () => `${Date.now() - start}ms`
  return {
    id: prefix,
    start,
    log:   (...a) => console.log(`[capture:${prefix}] +${elapsed()}`, ...a),
    warn:  (...a) => console.warn(`[capture:${prefix}] +${elapsed()} ⚠️`, ...a),
    error: (...a) => console.error(`[capture:${prefix}] +${elapsed()} ❌`, ...a),
  }
}

console.log('========================================')
console.log('[capture] BOOTING — pure CDP build (no Playwright, no Puppeteer)')
console.log('[capture] PORT=', PORT, '| WIDTH x HEIGHT=', WIDTH, 'x', HEIGHT, '| SCALE=', SCALE, '| CRF=', CRF, '| FPS_OUT=', FPS_OUT)
console.log('[capture] CHROME_PATH=', CHROME_PATH || '(auto-detect via chrome-launcher)')
console.log('[capture] OUTPUT_DIR=', OUTPUT_DIR)
console.log('========================================')

const app = express()
app.use(express.json({ limit: '2mb' }))

app.use((req, _res, next) => {
  const safeBody = { ...(req.body || {}) }
  if (safeBody.token) safeBody.token = `${String(safeBody.token).slice(0, 8)}...`
  console.log(`[http] ${new Date().toISOString()} ${req.method} ${req.originalUrl} body=${JSON.stringify(safeBody)}`)
  next()
})

app.use((req, res, next) => {
  if (!TOKEN) return next()
  const auth = req.headers.authorization || ''
  if (auth === `Bearer ${TOKEN}`) return next()
  console.warn('[auth] ❌ Unauthorized')
  res.status(401).json({ error: 'Unauthorized' })
})

app.get('/health', (_req, res) => res.json({ ok: true }))

// ── Build the /capture URL ─────────────────────────────────────────────────
// PRIMARY: { baseUrl, jobId, token } → ${baseUrl}/capture?jobId=...&token=...
// FALLBACK: { url } verbatim, or { baseUrl, projectId, flowId, ... }
function buildCaptureUrl({ baseUrl, url, jobId, token, projectId, flowId, seq, theme, duration }, log) {
  if (url) {
    log.log('buildCaptureUrl → url verbatim:', url)
    return url
  }
  const origin = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
  if (!origin) throw new Error('Missing baseUrl (and no CAPTURE_BASE_URL set)')

  if (jobId && token) {
    const qs = new URLSearchParams({ jobId, token })
    log.log('buildCaptureUrl → PRIMARY job path')
    return `${origin}/capture?${qs.toString()}`
  }
  if (projectId && flowId) {
    const qs = new URLSearchParams({ projectId, flowId })
    if (seq)      qs.set('seq', seq)
    if (theme)    qs.set('theme', theme)
    if (duration) qs.set('duration', String(duration))
    log.log('buildCaptureUrl → FALLBACK public-link path')
    return `${origin}/capture?${qs.toString()}`
  }
  throw new Error('Missing jobId/token (or projectId/flowId, or url)')
}

// ── POST /render ─────────────────────────────────────────────────────────
app.post('/render', async (req, res) => {
  __renderCounter += 1
  const renderId = `r${__renderCounter}-${Date.now()}`
  const log = makeLogger(renderId)

  const { baseUrl, url, jobId, token, projectId, flowId, seq, theme, duration } = req.body || {}

  let captureUrl
  try {
    captureUrl = buildCaptureUrl({ baseUrl, url, jobId, token, projectId, flowId, seq, theme, duration }, log)
  } catch (err) {
    log.error('buildCaptureUrl failed:', err.message)
    return res.status(400).json({ error: err.message })
  }

  const fallbackDurationMs = Number(duration) || 20_000
  const fileName = `nemo-${Date.now()}.mp4`
  const outPath  = path.join(OUTPUT_DIR, fileName)

  log.log('captureUrl =', captureUrl)
  log.log('fallbackDurationMs =', fallbackDurationMs)
  log.log('outPath =', outPath)

  captureViaCDP({ captureUrl, fallbackDurationMs, outPath, log })
    .then(() => {
      const stat = statSync(outPath)
      log.log(`✅ Render complete. Total time: ${Date.now() - log.start}ms | file size: ${stat.size} bytes`)
    })
    .catch((err) => {
      log.error('Render FAILED:', err?.message || err)
      log.error('Stack:', err?.stack || '(no stack)')
    })

  return res.status(202).json({ fileName })
})

app.get('/download/:fileName', async (req, res) => {
  const fileName = path.basename(req.params.fileName)
  const filePath = path.join(OUTPUT_DIR, fileName)
  if (!existsSync(filePath)) {
    console.warn(`[download] ⚠️ Not ready: ${filePath}`)
    return res.status(404).json({ error: 'Not ready' })
  }
  const stat = statSync(filePath)
  console.log(`[download] sending ${fileName} (${stat.size} bytes)`)
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
  res.sendFile(filePath)
})

// ── Core: launch Chromium, drive it over raw CDP, screencast → frames → mp4 ─
async function captureViaCDP({ captureUrl, fallbackDurationMs, outPath, log }) {
  await mkdir(OUTPUT_DIR, { recursive: true })
  const frameDir = path.join(TMP_DIR, `frames-${Date.now()}`)
  await mkdir(frameDir, { recursive: true })
  log.log('frameDir =', frameDir)

  log.log('Launching Chromium via chrome-launcher...')
  const physicalWidth  = WIDTH * SCALE
  const physicalHeight = HEIGHT * SCALE

  const chrome = await chromeLauncher.launch({
    chromePath: CHROME_PATH,
    chromeFlags: [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--disable-gpu-sandbox',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      `--window-size=${WIDTH},${HEIGHT}`,
      `--force-device-scale-factor=${SCALE}`,
      '--autoplay-policy=no-user-gesture-required', // let <video>/animations play without interaction
    ],
  })
  log.log(`Chromium launched. pid=${chrome.pid} port=${chrome.port}`)

  let client
  try {
    log.log('Connecting CDP client...')
    client = await CDP({ port: chrome.port })
    const { Page, Runtime, Network, Log: CdpLog, Emulation } = client

    log.log('Enabling CDP domains: Page, Runtime, Network, Log...')
    await Promise.all([Page.enable(), Runtime.enable(), Network.enable(), CdpLog.enable()])

    // Pipe browser-side logs/errors/network failures back to our logs.
    Runtime.consoleAPICalled((params) => {
      const text = (params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
      log.log(`[page console:${params.type}]`, text)
    })
    Runtime.exceptionThrown((params) => {
      log.error('[page exception]', params.exceptionDetails?.text, params.exceptionDetails?.exception?.description || '')
    })
    Network.responseReceived((params) => {
      if (params.response.status >= 400) {
        log.warn('[network]', params.response.status, params.response.url)
      }
    })
    Network.loadingFailed((params) => {
      log.error('[network failed]', params.errorText, params.type)
    })

    log.log('Setting device metrics override:', { physicalWidth, physicalHeight, SCALE })
    await Emulation.setDeviceMetricsOverride({
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: SCALE,
      mobile: false,
    })

    log.log('Navigating to captureUrl...')
    const navStart = Date.now()
    const loadedPromise = new Promise((resolve) => Page.loadEventFired(resolve))
    await Page.navigate({ url: captureUrl })
    await Promise.race([
      loadedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Navigation timeout (45s)')), 45_000)),
    ])
    log.log(`Page load event fired after ${Date.now() - navStart}ms`)

    log.log('Settling 1300ms (real time) for the page to mount...')
    await sleep(1300)

    // ── Check for page-reported error ──────────────────────────────────────
    const errCheck = await Runtime.evaluate({ expression: 'window.__nemoCaptureError || null', returnByValue: true })
    if (errCheck.result.value) {
      throw new Error(`Page reported error: ${errCheck.result.value}`)
    }
    log.log('No __nemoCaptureError reported')

    // ── Poll for __nemoCaptureReady in real time (no Playwright waitForFunction) ─
    log.log('Polling for window.__nemoCaptureReady === true (timeout 30s)...')
    const readyStart = Date.now()
    let ready = false
    while (Date.now() - readyStart < 30_000) {
      const r = await Runtime.evaluate({ expression: 'window.__nemoCaptureReady === true', returnByValue: true })
      if (r.result.value === true) { ready = true; break }
      await sleep(200)
    }
    if (!ready) {
      const diag = await Runtime.evaluate({
        expression: `JSON.stringify({ready: window.__nemoCaptureReady, error: window.__nemoCaptureError, durationMs: window.__nemoCaptureDurationMs, readyState: document.readyState})`,
        returnByValue: true,
      })
      log.error('Timed out waiting for __nemoCaptureReady. Diagnostic:', diag.result.value)
      throw new Error('Timed out waiting for __nemoCaptureReady')
    }
    log.log(`__nemoCaptureReady became true after ${Date.now() - readyStart}ms`)

    // ── Duration + start playback ────────────────────────────────────────
    const durRes = await Runtime.evaluate({ expression: 'window.__nemoCaptureDurationMs || 0', returnByValue: true })
    const durationMs = durRes.result.value || fallbackDurationMs
    log.log('durationMs =', durationMs, durRes.result.value ? '(from page)' : '(fallback)')

    const hasStart = await Runtime.evaluate({ expression: 'typeof window.__nemoCaptureStart === "function"', returnByValue: true })
    if (hasStart.result.value) {
      log.log('Calling window.__nemoCaptureStart()...')
      await Runtime.evaluate({ expression: 'window.__nemoCaptureStart()' })
    } else {
      log.warn('No __nemoCaptureStart on page — relying on page autoplay')
    }

    // ── Start screencast: PNG, quality 100 (lossless-ish), every repaint ───
    log.log('Starting Page.startScreencast (format=png, quality=100, everyNthFrame=1)...')
    const frames = [] // { index, ts, path }
    let frameIndex = 0
    const captureStartTs = Date.now()

    Page.screencastFrame(async (params) => {
      const { data, sessionId, metadata } = params
      // Ack immediately so Chromium keeps sending frames without throttling.
      Page.screencastFrameAck({ sessionId }).catch((e) => log.warn('screencastFrameAck failed:', e.message))

      const idx = frameIndex++
      const ts = (metadata?.timestamp ? metadata.timestamp * 1000 : Date.now()) // CDP timestamp is seconds
      const relativeMs = Date.now() - captureStartTs
      const filePath = path.join(frameDir, `f${String(idx).padStart(6, '0')}.png`)

      try {
        await writeFile(filePath, Buffer.from(data, 'base64'))
        frames.push({ index: idx, relativeMs, path: filePath })
        if (idx % 30 === 0) log.log(`  screencast frame ${idx} received @ +${relativeMs}ms, size=${Math.round(data.length * 0.75)} bytes`)
      } catch (writeErr) {
        log.error(`Failed writing frame ${idx}:`, writeErr.message)
      }
    })

    await Page.startScreencast({
      format: 'png',
      quality: 100,
      maxWidth: physicalWidth,
      maxHeight: physicalHeight,
      everyNthFrame: 1,
    })
    log.log(`Recording for ${durationMs}ms in real time (event-driven screencast)...`)

    await sleep(durationMs)

    log.log('Stopping screencast...')
    await Page.stopScreencast()
    // Give in-flight frame writes a moment to land.
    await sleep(300)

    log.log(`Total frames captured: ${frames.length} over ${durationMs}ms (avg ${(frames.length / (durationMs / 1000)).toFixed(1)} fps actual repaint rate)`)

    if (frames.length === 0) {
      throw new Error('Screencast produced ZERO frames — page never repainted during the capture window')
    }

    // ── Build an ffmpeg concat list using REAL inter-frame durations ───────
    // This preserves the actual timing of repaints instead of forcing a fixed
    // frame rate — critical for accuracy when repaint rate is irregular.
    log.log('Building ffmpeg concat list from real frame timestamps...')
    const concatLines = []
    for (let i = 0; i < frames.length; i++) {
      const cur = frames[i]
      const next = frames[i + 1]
      const durSec = next ? Math.max(0.001, (next.relativeMs - cur.relativeMs) / 1000) : (1 / FPS_OUT)
      concatLines.push(`file '${cur.path}'`)
      concatLines.push(`duration ${durSec.toFixed(4)}`)
    }
    // ffmpeg concat quirk: the last `duration` is ignored unless the file is
    // also repeated once more at the end.
    concatLines.push(`file '${frames[frames.length - 1].path}'`)
    const concatListPath = path.join(frameDir, 'concat.txt')
    await writeFile(concatListPath, concatLines.join('\n'))
    log.log('concat list written:', concatListPath, `(${frames.length} frames)`)

    log.log('Encoding final mp4 with ffmpeg (high quality: CRF', CRF, ')...')
    await encodeFromConcat({ concatListPath, outPath, log })

    log.log('Cleaning up frame directory...')
    await rm(frameDir, { recursive: true, force: true }).catch((e) => log.warn('cleanup failed:', e.message))
  } finally {
    if (client) await client.close().catch(() => {})
    log.log('Killing Chromium process...')
    await chrome.kill().catch((e) => log.warn('chrome.kill failed:', e.message))
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── ffmpeg: concat demuxer (real per-frame durations) → high quality mp4 ────
function encodeFromConcat({ concatListPath, outPath, log }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-vsync', 'vfr',
      '-vf', `scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`,
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', CRF,
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outPath,
    ]
    log.log('ffmpeg args:', args.join(' '))
    const ff = spawn(ffmpegPath, args)
    let stderr = ''
    ff.stderr.on('data', (d) => {
      const chunk = d.toString()
      stderr += chunk
      log.log('[ffmpeg]', chunk.trim())
    })
    ff.on('error', reject)
    ff.on('close', (code) => {
      if (code === 0) {
        log.log('ffmpeg encode complete →', outPath)
        resolve()
      } else {
        log.error('ffmpeg failed:', stderr.slice(-1500))
        reject(new Error(`ffmpeg exited with ${code}`))
      }
    })
  })
}

app.listen(PORT, () => {
  console.log(`[capture] worker listening on :${PORT} | ${WIDTH}x${HEIGHT} scale=${SCALE} crf=${CRF}`)
})
