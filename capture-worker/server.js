import express from 'express'
import { chromium } from 'playwright'
import ffmpegPath from 'ffmpeg-static'
import { spawn } from 'node:child_process'
import { mkdir, rename, rm } from 'node:fs/promises'
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

const DEFAULT_BASE_URL = process.env.CAPTURE_BASE_URL || ''
const OUTPUT_DIR = process.env.CAPTURE_OUTPUT_DIR || path.join(tmpdir(), 'nemo-captures')
const TMP_DIR = path.join(OUTPUT_DIR, '_tmp')

// ── Logging helpers ────────────────────────────────────────────────────────
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
console.log('[capture] BOOTING capture worker (3-method comparison build)')
console.log('[capture] PORT=', PORT, '| WIDTH x HEIGHT=', WIDTH, 'x', HEIGHT, '| FPS=', FPS, '| SCALE=', SCALE, '| CRF=', CRF)
console.log('[capture] DEFAULT_BASE_URL=', DEFAULT_BASE_URL || '(none)')
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

// ── POST /render — runs all 3 capture methods, stacks them, returns one file ──
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

  const fallbackDurationMs = Number(duration) || 8_000 // keep comparison runs short by default
  const compareFileName = `compare-${Date.now()}.mp4`
  const comparePath = path.join(OUTPUT_DIR, compareFileName)

  log.log('captureUrl =', captureUrl)
  log.log('fallbackDurationMs =', fallbackDurationMs)
  log.log('Kicking off 3-method comparison run in background...')

  runComparison({ captureUrl, fallbackDurationMs, comparePath, log })
    .then((result) => {
      log.log('✅ Comparison run complete:', JSON.stringify(result))
    })
    .catch((err) => {
      log.error('Comparison run FAILED:', err?.message || err)
      log.error('Stack:', err?.stack || '(no stack)')
    })

  // Respond immediately with the filenames the client will poll for.
  return res.status(202).json({
    compareFileName,
    methodFileNames: {
      driven:   compareFileName.replace('compare-', 'method-A-driven-'),
      realtime: compareFileName.replace('compare-', 'method-B-realtime-'),
      native:   compareFileName.replace('compare-', 'method-C-native-'),
    },
    note: 'Download compareFileName for the side-by-side video. Download the individual methodFileNames to inspect each one alone.',
  })
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

// ── Orchestrator: run all 3 methods, then stack ────────────────────────────
async function runComparison({ captureUrl, fallbackDurationMs, comparePath, log }) {
  await mkdir(OUTPUT_DIR, { recursive: true })
  await mkdir(TMP_DIR, { recursive: true })

  const stamp = path.basename(comparePath).replace('compare-', '').replace('.mp4', '')
  const pathA = path.join(OUTPUT_DIR, `method-A-driven-${stamp}.mp4`)
  const pathB = path.join(OUTPUT_DIR, `method-B-realtime-${stamp}.mp4`)
  const pathC = path.join(OUTPUT_DIR, `method-C-native-${stamp}.mp4`)

  log.log('Launching shared browser instance...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars',
           // Helps WebGL/canvas content actually paint in headless — relevant
           // since native recording (method C) is our control for "does GPU
           // content even render at all".
           '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  })

  const results = { driven: null, realtime: null, native: null }

  try {
    log.log('── METHOD A: driven (virtual clock) ──────────────────────')
    try {
      await captureDriven({ browser, captureUrl, fallbackDurationMs, outPath: pathA, log: makeLogger(`${log.id}:A`) })
      results.driven = { ok: true, path: pathA, size: statSync(pathA).size }
    } catch (err) {
      log.error('Method A failed:', err.message)
      results.driven = { ok: false, error: err.message }
    }

    log.log('── METHOD B: realtime screenshot loop ─────────────────────')
    try {
      await captureRealtime({ browser, captureUrl, fallbackDurationMs, outPath: pathB, log: makeLogger(`${log.id}:B`) })
      results.realtime = { ok: true, path: pathB, size: statSync(pathB).size }
    } catch (err) {
      log.error('Method B failed:', err.message)
      results.realtime = { ok: false, error: err.message }
    }

    log.log('── METHOD C: native Chromium video recording ──────────────')
    try {
      await captureNative({ browser, captureUrl, fallbackDurationMs, outPath: pathC, log: makeLogger(`${log.id}:C`) })
      results.native = { ok: true, path: pathC, size: statSync(pathC).size }
    } catch (err) {
      log.error('Method C failed:', err.message)
      results.native = { ok: false, error: err.message }
    }
  } finally {
    await browser.close().catch(() => {})
    log.log('Shared browser closed')
  }

  log.log('Results summary:', JSON.stringify(results, null, 2))

  log.log('Stacking the 3 outputs (that succeeded) into comparison video...')
  await stackVideos({
    inputs: [
      { path: pathA, label: 'A: DRIVEN (virtual clock)', ok: results.driven?.ok },
      { path: pathB, label: 'B: REALTIME (wall clock)',  ok: results.realtime?.ok },
      { path: pathC, label: 'C: NATIVE (Chromium record)', ok: results.native?.ok },
    ],
    outPath: comparePath,
    log,
  })

  return results
}

// ── METHOD A: driven — virtual clock + manual screenshot loop ─────────────
async function captureDriven({ browser, captureUrl, fallbackDurationMs, outPath, log }) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
  })
  await context.addInitScript(() => { window.__nemoCaptureDriven = true })
  const page = await context.newPage()
  attachPageLogging(page, log)

  try {
    log.log('Installing virtual clock...')
    await page.clock.install({ time: 0 })

    await page.goto(captureUrl, { waitUntil: 'load', timeout: 45_000 })
    await page.clock.runFor(1300)

    const captureError = await page.evaluate(() => window.__nemoCaptureError || null)
    if (captureError) throw new Error(`Page reported error: ${captureError}`)

    await page.waitForFunction(() => window.__nemoCaptureReady === true, { timeout: 30_000 })

    const reportedDurationMs = await page.evaluate(() => window.__nemoCaptureDurationMs)
    const durationMs = reportedDurationMs || fallbackDurationMs
    log.log('durationMs =', durationMs, reportedDurationMs ? '(from page)' : '(fallback)')

    const frameMs = 1000 / FPS
    const totalFrames = Math.round((durationMs / 1000) * FPS) + 1
    log.log('totalFrames =', totalFrames)

    await page.evaluate(() => window.__nemoCaptureStart && window.__nemoCaptureStart())

    const ff = spawnFfmpeg(outPath, log)
    let advancedMs = 0
    for (let i = 0; i < totalFrames; i++) {
      const targetMs = Math.round(i * frameMs)
      const step = targetMs - advancedMs
      advancedMs = targetMs
      if (step > 0) await page.clock.runFor(step)
      const png = await page.screenshot({ type: 'png' })
      if (i % 30 === 0) log.log(`frame ${i + 1}/${totalFrames}, bytes=${png.length}`)
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r))
    }
    ff.stdin.end()
    await ff.done
    log.log('Method A done →', outPath)
  } finally {
    await context.close().catch(() => {})
  }
}

// ── METHOD B: realtime — no clock manipulation, real wall-clock screenshots ─
async function captureRealtime({ browser, captureUrl, fallbackDurationMs, outPath, log }) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
  })
  const page = await context.newPage()
  attachPageLogging(page, log)

  try {
    log.log('Navigating (NO virtual clock, NO driven flag)...')
    await page.goto(captureUrl, { waitUntil: 'load', timeout: 45_000 })

    // Real wait — let any natural autoplay/load sequence settle.
    await page.waitForTimeout(1300)

    // If the page exposes ready/start hooks, use them — but don't require it.
    const hasReady = await page.evaluate(() => typeof window.__nemoCaptureReady !== 'undefined')
    if (hasReady) {
      log.log('Page exposes __nemoCaptureReady — waiting for it in real time...')
      await page.waitForFunction(() => window.__nemoCaptureReady === true, { timeout: 30_000 }).catch((e) => {
        log.warn('Timed out waiting for __nemoCaptureReady in realtime mode, continuing anyway:', e.message)
      })
    } else {
      log.log('Page does not expose __nemoCaptureReady — assuming it plays on its own once loaded.')
    }

    const hasStart = await page.evaluate(() => typeof window.__nemoCaptureStart === 'function')
    if (hasStart) {
      log.log('Calling __nemoCaptureStart() (real time)...')
      await page.evaluate(() => window.__nemoCaptureStart())
    } else {
      log.log('No __nemoCaptureStart — relying on the page auto-playing by itself (real public-page behavior).')
    }

    const durationMs = fallbackDurationMs
    const frameMs = 1000 / FPS
    const totalFrames = Math.round((durationMs / 1000) * FPS) + 1
    log.log('durationMs =', durationMs, '| totalFrames =', totalFrames)

    const ff = spawnFfmpeg(outPath, log)
    const loopStart = Date.now()
    for (let i = 0; i < totalFrames; i++) {
      const targetMs = i * frameMs
      const waitMs = targetMs - (Date.now() - loopStart)
      if (waitMs > 0) await page.waitForTimeout(waitMs)
      const png = await page.screenshot({ type: 'png' })
      if (i % 30 === 0) log.log(`frame ${i + 1}/${totalFrames}, bytes=${png.length}, realElapsed=${Date.now() - loopStart}ms`)
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r))
    }
    ff.stdin.end()
    await ff.done
    log.log('Method B done →', outPath)
  } finally {
    await context.close().catch(() => {})
  }
}

// ── METHOD C: native — Chromium's own video recorder (real compositor) ─────
async function captureNative({ browser, captureUrl, fallbackDurationMs, outPath, log }) {
  const recordDir = path.join(TMP_DIR, `native-${Date.now()}`)
  await mkdir(recordDir, { recursive: true })

  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: recordDir, size: { width: WIDTH, height: HEIGHT } },
  })
  const page = await context.newPage()
  attachPageLogging(page, log)

  try {
    log.log('Navigating (native recording active, real time, real compositor)...')
    await page.goto(captureUrl, { waitUntil: 'load', timeout: 45_000 })
    await page.waitForTimeout(1300)

    const hasReady = await page.evaluate(() => typeof window.__nemoCaptureReady !== 'undefined')
    if (hasReady) {
      await page.waitForFunction(() => window.__nemoCaptureReady === true, { timeout: 30_000 }).catch((e) => {
        log.warn('Timed out waiting for __nemoCaptureReady in native mode, continuing anyway:', e.message)
      })
    }
    const hasStart = await page.evaluate(() => typeof window.__nemoCaptureStart === 'function')
    if (hasStart) {
      await page.evaluate(() => window.__nemoCaptureStart())
    }

    const durationMs = fallbackDurationMs
    log.log(`Letting it play for ${durationMs}ms in real time while Chromium records natively...`)
    await page.waitForTimeout(durationMs)

    log.log('Closing context to flush the native recording...')
    const video = page.video()
    await context.close()
    const rawPath = await video.path()
    log.log('Native recording saved at', rawPath)

    log.log('Transcoding native .webm → .mp4 with ffmpeg...')
    await transcodeToMp4(rawPath, outPath, log)
    log.log('Method C done →', outPath)
  } catch (err) {
    await context.close().catch(() => {})
    throw err
  } finally {
    await rm(recordDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── Shared: page-level console/error logging ────────────────────────────────
function attachPageLogging(page, log) {
  page.on('console', (msg) => log.log(`[page console:${msg.type()}]`, msg.text()))
  page.on('pageerror', (err) => log.error('[page pageerror]', err.message))
  page.on('requestfailed', (r) => log.error('[page requestfailed]', r.method(), r.url(), '→', r.failure()?.errorText))
  page.on('response', (r) => { if (r.status() >= 400) log.warn('[page response]', r.status(), r.url()) })
  page.on('crash', () => log.error('[page] CRASHED'))
}

// ── ffmpeg: PNG stream → mp4 ────────────────────────────────────────────────
function spawnFfmpeg(output, log) {
  const args = [
    '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', 'pipe:0',
    '-vf', `scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF, '-tune', 'animation',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
  ]
  const ff = spawn(ffmpegPath, args)
  let stderr = ''
  ff.stderr.on('data', (d) => { stderr += d.toString() })
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject)
    ff.on('close', (code) => {
      if (code === 0) resolve(output)
      else { log.error('ffmpeg failed:', stderr.slice(-1000)); reject(new Error(`ffmpeg exited ${code}`)) }
    })
  })
  return { stdin: ff.stdin, done }
}

// ── ffmpeg: transcode any video (e.g. webm) → mp4 ───────────────────────────
function transcodeToMp4(inputPath, outputPath, log) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', inputPath, '-c:v', 'libx264', '-preset', 'slow',
                  '-crf', CRF, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath]
    const ff = spawn(ffmpegPath, args)
    let stderr = ''
    ff.stderr.on('data', (d) => { stderr += d.toString() })
    ff.on('error', reject)
    ff.on('close', (code) => {
      if (code === 0) resolve(outputPath)
      else { log.error('transcode failed:', stderr.slice(-1000)); reject(new Error(`ffmpeg transcode exited ${code}`)) }
    })
  })
}

// ── ffmpeg: stack up to 3 mp4s vertically with labels into one file ────────
async function stackVideos({ inputs, outPath, log }) {
  const usable = inputs.filter((i) => i.ok && existsSync(i.path))
  log.log(`stackVideos: ${usable.length}/${inputs.length} methods produced usable output`)

  if (usable.length === 0) {
    log.error('No method produced output — cannot build comparison video')
    throw new Error('All 3 capture methods failed — see logs above for each')
  }

  const args = ['-y']
  usable.forEach((i) => args.push('-i', i.path))

  const scaleLabel = usable
    .map((i, idx) =>
      `[${idx}:v]scale=640:-2,setpts=PTS-STARTPTS,drawtext=text='${i.label.replace(/'/g, "")}':fontcolor=white:fontsize=20:x=10:y=10:box=1:boxcolor=black@0.6[v${idx}]`
    )
    .join(';')
  const stackInputs = usable.map((_, idx) => `[v${idx}]`).join('')
  const filter = `${scaleLabel};${stackInputs}vstack=${usable.length}[outv]`

  args.push('-filter_complex', filter, '-map', '[outv]', '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF, '-pix_fmt', 'yuv420p', outPath)

  log.log('stackVideos ffmpeg args:', args.join(' '))

  await new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args)
    let stderr = ''
    ff.stderr.on('data', (d) => { stderr += d.toString() })
    ff.on('error', reject)
    ff.on('close', (code) => {
      if (code === 0) {
        log.log('Comparison video built successfully →', outPath)
        resolve()
      } else {
        log.error('Stacking with drawtext failed, retrying WITHOUT labels (font issue is common cause):', stderr.slice(-800))
        // Retry without drawtext in case fontconfig isn't available in the image.
        const simpleFilter = usable
          .map((_, idx) => `[${idx}:v]scale=640:-2,setpts=PTS-STARTPTS[v${idx}]`)
          .join(';') + ';' + usable.map((_, idx) => `[v${idx}]`).join('') + `vstack=${usable.length}[outv]`
        const retryArgs = ['-y']
        usable.forEach((i) => retryArgs.push('-i', i.path))
        retryArgs.push('-filter_complex', simpleFilter, '-map', '[outv]', '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF, '-pix_fmt', 'yuv420p', outPath)
        const ff2 = spawn(ffmpegPath, retryArgs)
        let stderr2 = ''
        ff2.stderr.on('data', (d) => { stderr2 += d.toString() })
        ff2.on('error', reject)
        ff2.on('close', (code2) => {
          if (code2 === 0) { log.log('Comparison video built (no labels, fallback) →', outPath); resolve() }
          else { log.error('Fallback stacking also failed:', stderr2.slice(-1000)); reject(new Error('ffmpeg stacking failed twice')) }
        })
      }
    })
  })
}

app.listen(PORT, () => {
  console.log(`[capture] worker listening on :${PORT} | ${WIDTH}x${HEIGHT}@${FPS} scale=${SCALE} crf=${CRF}`)
})
