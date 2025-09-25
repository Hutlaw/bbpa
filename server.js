const express = require('express')
const http = require('http')
const https = require('https')
const path = require('path')
const WebSocket = require('ws')
const fs = require('fs')
const { spawn, spawnSync } = require('child_process')
let fetchFunc = null
if (typeof globalThis.fetch === 'function') fetchFunc = globalThis.fetch.bind(globalThis)
else {
  try {
    const nf = require('node-fetch')
    fetchFunc = (nf && nf.default) ? nf.default : nf
  } catch (e) {
    fetchFunc = null
  }
}
let puppeteer
try {
  puppeteer = require('puppeteer')
} catch (e) {
  console.error('Install dependencies: npm install')
  process.exit(1)
}
const APP_PORT = parseInt(process.env.PORT || '3000', 10)
const HOSTS_TO_TRY = ['0.0.0.0', '::', '127.0.0.1']
const VIEWPORT = { width: 1280, height: 800 }
const MAX_FPS = Math.max(5, Math.min(60, parseInt(process.env.MAX_FPS || '15', 10)))
const FRAME_INTERVAL_MS = Math.round(1000 / MAX_FPS)
const JPEG_QUALITY = Math.max(10, Math.min(95, parseInt(process.env.JPEG_QUALITY || '60', 10)))
function execOk(p) {
  try {
    const r = spawnSync(p, ['--version'], { timeout: 2000 })
    return r.status === 0
  } catch (e) {
    return false
  }
}
function findChromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/chrome'
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && execOk(p)) return p
    } catch (e) {}
  }
  try {
    const whichChrome = spawnSync('which', ['google-chrome-stable']).stdout.toString().trim()
    if (whichChrome && execOk(whichChrome)) return whichChrome
  } catch (e) {}
  return null
}
function prettyInterfaces() {
  const os = require('os')
  const ifs = os.networkInterfaces()
  const out = []
  for (const k of Object.keys(ifs)) {
    for (const v of ifs[k]) {
      out.push({ iface: k, address: v.address, family: v.family, internal: v.internal })
    }
  }
  return out
}
function checkClockSkew(callback) {
  const req = https.request({ method: 'GET', host: 'www.google.com', path: '/', timeout: 5000 }, (res) => {
    const dateHeader = res.headers && res.headers.date
    if (!dateHeader) return callback(null, 0)
    const serverTime = Date.parse(dateHeader)
    if (isNaN(serverTime)) return callback(null, 0)
    const now = Date.now()
    const skewMs = now - serverTime
    callback(null, skewMs)
  })
  req.on('error', (err) => callback(err, null))
  req.on('timeout', () => { req.destroy(); callback(new Error('timeout'), null) })
  req.end()
}
const SESSION_FILE = path.join(__dirname, 'session_state.json')
function loadSessionState() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8') || '{}')
    }
  } catch (e) {}
  return {}
}
function saveSessionState(state) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(state || {}, null, 2), 'utf8')
  } catch (e) {}
}
async function start() {
  await new Promise((resolve) => {
    checkClockSkew((err, skewMs) => {
      if (err) console.warn('Clock check error:', err.message)
      else {
        const absSkew = Math.abs(skewMs)
        if (absSkew > 5000) {
          console.warn('System clock skew detected. Difference (ms):', skewMs)
          console.warn('Large clock skew can trigger security checks on some sites. Consider syncing the system clock.')
        } else {
          console.log('System clock check OK. Skew (ms):', skewMs)
        }
      }
      resolve()
    })
  })
  const chromePath = findChromeExecutable()
  const userDataDir = process.env.USER_DATA_DIR || '/workspaces/codespaces-blank/chrome-profile'
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true })
  try { fs.chmodSync(userDataDir, 0o700) } catch (e) {}
  const launchOptions = { args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--disable-gpu', '--enable-logging'] }
  if (process.env.HEADFUL === '1') launchOptions.headless = false
  else launchOptions.headless = true
  if (chromePath) launchOptions.executablePath = chromePath
  if (userDataDir) launchOptions.userDataDir = userDataDir
  const browser = await puppeteer.launch(launchOptions)
  const app = express()
  app.use(express.static(path.join(__dirname, 'public')))
  app.get('/__health', (req, res) => res.json({ status: 'ok', pid: process.pid, chrome: chromePath || null, userDataDir }))
  const server = http.createServer(app)
  const wss = new WebSocket.Server({ noServer: true })
  const wsaudio = new WebSocket.Server({ noServer: true })
  let ffmpegProcess = null
  function startAudioCapture() {
    if (ffmpegProcess) return
    try {
      ffmpegProcess = spawn('ffmpeg', ['-f', 'pulse', '-i', 'default', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'inherit'] })
      ffmpegProcess.stdout.on('data', (chunk) => {
        wsaudio.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(chunk) })
      })
      ffmpegProcess.on('close', () => { ffmpegProcess = null })
    } catch (e) {
      ffmpegProcess = null
    }
  }
  startAudioCapture()
  server.on('upgrade', (request, socket, head) => {
    if (request.url.startsWith('/ws')) {
      wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request) })
    } else if (request.url.startsWith('/audio')) {
      wsaudio.handleUpgrade(request, socket, head, (ws) => { wsaudio.emit('connection', ws, request) })
    } else {
      socket.destroy()
    }
  })
  let lastUserActivityTs = Date.now()
  let warnSent = false
  async function pollCodespaceIdle() {
    const token = process.env.GITHUB_TOKEN
    const name = process.env.CODESPACE_NAME
    const warnMinutes = parseInt(process.env.IDLE_WARN_MINUTES || '15', 10)
    if (!token || !name || !fetchFunc) return
    try {
      const url = `https://api.github.com/user/codespaces/${encodeURIComponent(name)}`
      const res = await fetchFunc(url, { headers: { Authorization: `token ${token}`, 'User-Agent': 'codespace-checker' }})
      if (!res || !res.ok) return
      const js = await res.json()
      const dates = Object.keys(js).map(k => ({k, v: js[k]})).filter(x => typeof x.v === 'string' && x.v.match(/T.*Z$/))
      let latest = 0
      dates.forEach(x => { const t = Date.parse(x.v); if (!isNaN(t) && t > latest) latest = t })
      if (latest) {
        const idleMin = (Date.now() - latest) / 60000
        if (idleMin > warnMinutes && !warnSent) {
          warnSent = true
          broadcastAll({ type: 'warning', message: `Codespace idle for ${Math.round(idleMin)} minutes — it may suspend soon.` })
          console.warn(`Codespace idle for ${Math.round(idleMin)} minutes — may suspend soon.`)
        }
      }
    } catch (e) {}
  }
  setInterval(async () => {
    await pollCodespaceIdle()
  }, 60000)
  function broadcastAll(obj) {
    const s = JSON.stringify(obj)
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(s) })
  }
  wss.on('connection', async (ws) => {
    lastUserActivityTs = Date.now()
    warnSent = false
    let page
    let cdp
    let lastFrameTs = 0
    let sendingFrame = false
    try {
      page = await browser.newPage()
      await page.setViewport(VIEWPORT)
      const saved = loadSessionState()
      const startUrl = saved.url || 'https://www.google.com'
      await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 30000 })
      try {
        if (saved.scrollY || saved.scrollX) {
          await page.evaluate((x,y) => { window.scrollTo(x || 0, y || 0) }, saved.scrollX || 0, saved.scrollY || 0)
        }
      } catch (e) {}
      cdp = await page.target().createCDPSession()
      await cdp.send('Page.enable')
      await cdp.send('Runtime.enable')
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: JPEG_QUALITY, everyNthFrame: 1 })
      ws.send(JSON.stringify({ type: 'init', width: VIEWPORT.width, height: VIEWPORT.height, maxFps: MAX_FPS }))
      cdp.on('Page.screencastFrame', async (event) => {
        const now = Date.now()
        await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId })
        if (ws.readyState !== WebSocket.OPEN) return
        if (now - lastFrameTs < FRAME_INTERVAL_MS) return
        if (sendingFrame) return
        lastFrameTs = now
        try {
          const buf = Buffer.from(event.data, 'base64')
          sendingFrame = true
          ws.send(buf, { binary: true }, () => { sendingFrame = false })
        } catch (e) {
          sendingFrame = false
        }
      })
      ws.on('message', async (msg) => {
        lastUserActivityTs = Date.now()
        try {
          let text = null
          if (typeof msg === 'string') text = msg
          else if (msg instanceof Buffer) text = msg.toString()
          else if (msg instanceof ArrayBuffer) text = Buffer.from(msg).toString()
          else text = String(msg)
          const data = JSON.parse(text)
          if (data.type === 'mouse') {
            const x = Math.round(data.x)
            const y = Math.round(data.y)
            if (data.action === 'move') {
              page.mouse.move(x, y).catch(() => {})
            } else if (data.action === 'down') {
              await page.mouse.move(x, y)
              await page.mouse.down({ button: data.button || 'left', clickCount: data.clickCount || 1 })
            } else if (data.action === 'up') {
              await page.mouse.move(x, y)
              await page.mouse.up({ button: data.button || 'left', clickCount: data.clickCount || 1 })
            } else if (data.action === 'click') {
              await page.mouse.move(x, y)
              await page.mouse.click(x, y, { button: data.button || 'left', clickCount: data.clickCount || 1 })
            }
          } else if (data.type === 'scroll') {
            const dx = Number(data.deltaX || 0)
            const dy = Number(data.deltaY || data.delta || 0)
            try {
              await page.mouse.wheel({ deltaX: dx, deltaY: dy })
            } catch (e) {}
            try {
              await page.evaluate((a,b) => {
                const cx = Math.floor(window.innerWidth/2)
                const cy = Math.floor(window.innerHeight/2)
                const target = document.elementFromPoint(cx, cy) || document.body
                target.dispatchEvent(new WheelEvent('wheel', { deltaX: a, deltaY: b, bubbles: true, cancelable: true }))
              }, dx, dy)
            } catch (e) {}
            try {
              const pos = await page.evaluate(() => ({scrollX: window.scrollX, scrollY: window.scrollY}))
              const st = loadSessionState()
              st.scrollX = pos.scrollX
              st.scrollY = pos.scrollY
              saveSessionState(st)
            } catch (e) {}
          } else if (data.type === 'keyboard') {
            if (data.action === 'press') {
              await page.keyboard.press(String(data.key || ''), { delay: data.delay || 0 })
            } else if (data.action === 'type') {
              await page.keyboard.type(String(data.text || ''), { delay: data.delay || 0 })
            } else if (data.action === 'down') {
              await page.keyboard.down(String(data.key))
            } else if (data.action === 'up') {
              await page.keyboard.up(String(data.key))
            }
          } else if (data.type === 'navigate') {
            if (typeof data.url === 'string') {
              await page.goto(data.url, { waitUntil: 'networkidle2', timeout: 30000 })
              const st = loadSessionState()
              st.url = data.url
              st.scrollX = 0
              st.scrollY = 0
              saveSessionState(st)
              ws.send(JSON.stringify({ type: 'navigated', url: data.url }))
            }
          } else if (data.type === 'resize') {
            if (data.width && data.height) {
              const w = Math.max(100, Math.round(Number(data.width)))
              const h = Math.max(100, Math.round(Number(data.height)))
              await page.setViewport({ width: w, height: h })
              ws.send(JSON.stringify({ type: 'resizeAck', width: w, height: h }))
            }
          } else if (data.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }))
          }
        } catch (err) {
          try { ws.send(JSON.stringify({ type: 'error', message: String(err) })) } catch (e) {}
        }
      })
      ws.on('close', async () => {
        try {
          if (page && !page.isClosed()) {
            const pos = await page.evaluate(() => ({url: location.href, scrollX: window.scrollX, scrollY: window.scrollY}))
            const st = loadSessionState()
            st.url = pos.url || st.url
            st.scrollX = pos.scrollX
            st.scrollY = pos.scrollY
            saveSessionState(st)
            await page.close()
          }
        } catch (e) {}
      })
      ws.on('error', async () => {
        try {
          if (page && !page.isClosed()) {
            const pos = await page.evaluate(() => ({url: location.href, scrollX: window.scrollX, scrollY: window.scrollY}))
            const st = loadSessionState()
            st.url = pos.url || st.url
            st.scrollX = pos.scrollX
            st.scrollY = pos.scrollY
            saveSessionState(st)
            await page.close()
          }
        } catch (e) {}
      })
    } catch (err) {
      try { ws.send(JSON.stringify({ type: 'error', message: String(err) })) } catch (e) {}
      if (page && !page.isClosed()) await page.close().catch(() => {})
    }
  })
  function tryListen(hostIndex = 0) {
    const host = HOSTS_TO_TRY[hostIndex] || '0.0.0.0'
    server.listen(APP_PORT, host, () => {
      const addr = server.address()
      console.log(`Server listening on http://${addr.address}:${addr.port}`)
      console.log(`PID: ${process.pid}`)
      console.log(`WS endpoint ws://${addr.address}:${addr.port}/ws`)
      console.log(`Audio WS endpoint ws://${addr.address}:${addr.port}/audio`)
      console.log('Health check: GET http://%s:%d/__health', addr.address, addr.port)
      console.log('Network interfaces:', JSON.stringify(prettyInterfaces(), null, 2))
    }).on('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && hostIndex + 1 < HOSTS_TO_TRY.length) {
        tryListen(hostIndex + 1)
      } else {
        console.error('Failed to bind server:', err)
        process.exit(1)
      }
    })
  }
  tryListen(0)
  process.on('SIGINT', async () => {
    try { broadcastAll({ type: 'warning', message: 'Server shutting down' }) } catch (e) {}
    try { if (ffmpegProcess) ffmpegProcess.kill() } catch (e) {}
    try { await browser.close() } catch (e) {}
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    try { broadcastAll({ type: 'warning', message: 'Server shutting down' }) } catch (e) {}
    try { if (ffmpegProcess) ffmpegProcess.kill() } catch (e) {}
    try { await browser.close() } catch (e) {}
    process.exit(0)
  })
}
start().catch((err) => {
  console.error(err)
  process.exit(1)
})
