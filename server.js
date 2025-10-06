const express = require('express')
const http = require('http')
const https = require('https')
const path = require('path')
const WebSocket = require('ws')
const fs = require('fs')
const os = require('os')
const { spawn, spawnSync } = require('child_process')
const { finished } = require('stream')

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

let puppeteerExtra
let StealthPlugin
let puppeteer
try {
  puppeteerExtra = require('puppeteer-extra')
  StealthPlugin = require('puppeteer-extra-plugin-stealth')
  puppeteerExtra.use(StealthPlugin())
  puppeteer = puppeteerExtra
} catch (e) {
  try {
    puppeteer = require('puppeteer')
  } catch (err) {
    console.error('Install dependencies: npm install')
    process.exit(1)
  }
}

const multer = require('multer')
const APP_PORT = parseInt(process.env.PORT || '3000', 10)
const VIEWPORT = { width: 1280, height: 800 }
const MAX_FPS = Math.max(5, Math.min(60, parseInt(process.env.MAX_FPS || '15', 10)))
const FRAME_INTERVAL_MS = Math.round(1000 / MAX_FPS)
const JPEG_QUALITY = Math.max(10, Math.min(95, parseInt(process.env.JPEG_QUALITY || '60', 10)))

function execOk(p) {
  try {
    const r = spawnSync(p, ['-version'], { timeout: 2000 })
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

function makeId() {
  return Math.random().toString(36).slice(2, 10)
}

function rimrafSync(p) {
  try {
    if (!fs.existsSync(p)) return
    try {
      fs.rmSync(p, { recursive: true, force: true })
      return
    } catch (e) {}
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p)) rimrafSync(path.join(p, f))
      try { fs.rmdirSync(p) } catch (e) {}
    } else fs.unlinkSync(p)
  } catch (e) {}
}

function ensureModuleInstalled(name, version) {
  try {
    return require(name)
  } catch (err) {
    try {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const sp = spawnSync(npmCmd, ['install', `${name}@${version}`, '--no-audit', '--no-fund'], { stdio: 'inherit', timeout: 120000 })
      if (sp.status === 0) {
        try { return require(name) } catch (e) { return null }
      } else return null
    } catch (e) { return null }
  }
}

const Archiver = ensureModuleInstalled('archiver', '5.3.1')
const AdmZip = ensureModuleInstalled('adm-zip', '0.5.9')
const Unzipper = ensureModuleInstalled('unzipper', '0.10.11')
const Tar = ensureModuleInstalled('tar', '6.1.11')

let browser = null
let launchOptions = null
let chromePath = null
const userDataDir = process.env.USER_DATA_DIR || path.join(__dirname, 'chrome-profile')

async function restartBrowser() {
  try {
    if (browser) {
      try { await browser.close() } catch (e) {}
      browser = null
    }
    browser = await puppeteer.launch(launchOptions)
    return browser
  } catch (e) {
    console.error('Failed to restart browser:', e)
    throw e
  }
}

async function start() {
  await new Promise((resolve) => {
    checkClockSkew((err, skewMs) => {
      resolve()
    })
  })
  chromePath = findChromeExecutable()
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true })
  try { fs.chmodSync(userDataDir, 0o700) } catch (e) {}
  const uploadsDir = path.join(userDataDir, 'uploads')
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
  const downloadsDir = path.join(userDataDir, 'downloads')
  if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true })
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,8)}-${file.originalname}`)
  })
  const uploadMw = multer({ storage })
  launchOptions = { args: ['--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--disable-gpu', '--enable-logging', '--disable-blink-features=AutomationControlled', '--disable-infobars', '--no-default-browser-check', '--disable-extensions', '--start-maximized'], headless: true }
  if (process.env.HEADFUL === '1') launchOptions.headless = false
  if (process.env.NO_SANDBOX === '1') {
    launchOptions.args.unshift('--no-sandbox', '--disable-setuid-sandbox')
  } else {
    if (process.env.FORCE_NO_SANDBOX === '1') launchOptions.args.unshift('--no-sandbox', '--disable-setuid-sandbox')
  }
  if (chromePath) launchOptions.executablePath = chromePath
  if (userDataDir) launchOptions.userDataDir = userDataDir
  const defaultUserAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
  browser = await puppeteer.launch(launchOptions)
  const app = express()
  app.use(express.static(path.join(__dirname, 'public')))
  app.get('/__health', (req, res) => res.json({ status: 'ok', pid: process.pid, chrome: chromePath || null, userDataDir }))
  app.post('/upload', uploadMw.single('file'), async (req, res) => {
    try {
      const tabId = req.body.tabId
      const connId = req.body.connId
      if (!req.file) return res.status(400).json({ ok: false, message: 'no file' })
      if (!connId || !tabId) {
        return res.status(400).json({ ok: false, message: 'missing connId or tabId' })
      }
      const session = connections[connId]
      if (!session) return res.status(404).json({ ok: false, message: 'connection not found' })
      const tab = session.tabs.get(tabId)
      if (!tab) return res.status(404).json({ ok: false, message: 'tab not found' })
      const localPath = req.file.path
      try {
        const handle = await tab.page.evaluateHandle(() => {
          const ae = document.activeElement
          if (ae && ae.tagName === 'INPUT' && ae.type === 'file') return ae
          return null
        })
        let elementHandle = null
        try {
          if (handle && handle.asElement()) elementHandle = handle.asElement()
        } catch (e) {
          elementHandle = null
        }
        if (!elementHandle) {
          const inputs = await tab.page.$$('input[type=file]')
          if (inputs && inputs.length) elementHandle = inputs[0]
        }
        if (!elementHandle) {
          return res.status(400).json({ ok: false, message: 'no file input found on the page' })
        }
        await elementHandle.uploadFile(localPath)
        res.json({ ok: true })
      } catch (e) {
        res.status(500).json({ ok: false, message: String(e) })
      }
    } catch (err) {
      res.status(500).json({ ok: false, message: String(err) })
    }
  })
  let downloadTokens = new Map()
  app.get('/download', (req, res) => {
    const token = String(req.query.token || '')
    if (!token) return res.status(400).send('missing token')
    const info = downloadTokens.get(token)
    if (!info) return res.status(404).send('not found')
    const stat = fs.existsSync(info.path) ? fs.statSync(info.path) : null
    if (!stat) return res.status(404).send('file missing')
    res.setHeader('Content-Type', info.mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${info.filename.replace(/"/g, '\\"')}"`)
    const stream = fs.createReadStream(info.path)
    stream.pipe(res)
  })
  const server = http.createServer(app)
  const wss = new WebSocket.Server({ noServer: true })
  const wsaudio = new WebSocket.Server({ noServer: true })
  function broadcastAll(obj) {
    const s = JSON.stringify(obj)
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(s) })
  }
  let ffmpegProcess = null
  let audioAvailable = false
  function startAudioCapture() {
    if (ffmpegProcess) return
    if (!execOk('ffmpeg')) {
      audioAvailable = false
      broadcastAll({ type: 'audio-available', available: false })
      return
    }
    try {
      ffmpegProcess = spawn('ffmpeg', ['-f', 'pulse', '-i', 'default', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'inherit'] })
      audioAvailable = true
      broadcastAll({ type: 'audio-available', available: true })
      ffmpegProcess.stdout.on('data', (chunk) => {
        wsaudio.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(chunk) })
      })
      ffmpegProcess.on('close', () => {
        ffmpegProcess = null
        audioAvailable = false
        broadcastAll({ type: 'audio-available', available: false })
      })
    } catch (e) {
      ffmpegProcess = null
      audioAvailable = false
      broadcastAll({ type: 'audio-available', available: false })
    }
  }
  function stopAudioCapture() {
    try {
      if (ffmpegProcess) {
        ffmpegProcess.kill('SIGTERM')
        ffmpegProcess = null
      }
    } catch (e) {}
    audioAvailable = false
    broadcastAll({ type: 'audio-available', available: false })
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
  let connections = {}
  async function applyStealthLikeHardening(page) {
    try {
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })
      await page.setUserAgent(defaultUserAgent)
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] })
        Object.defineProperty(navigator, 'plugins', { get: () => [{name:'Chrome PDF Plugin'},{name:'Widevine Content Decryption Module'}] })
        window.navigator.permissions.query = (parameters) => Promise.resolve({ state: 'granted', onchange: null })
        window.chrome = window.chrome || { runtime: {} }
        try {
          const get = Element.prototype.getAttribute
          Element.prototype.getAttribute = function(name) {
            return get.call(this, name)
          }
        } catch (e) {}
      })
    } catch (e) {}
  }
  async function createTabForSession(session, url) {
    const id = makeId()
    const page = await browser.newPage()
    await page.setViewport(VIEWPORT)
    await applyStealthLikeHardening(page)
    const cdp = await page.target().createCDPSession()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    const tab = { id, page, cdp, url: url || 'about:blank', lastFrameTs: 0, sendingFrame: false }
    await page.exposeFunction(`__fileInputActivated_${id}`, () => {
      try {
        if (session && session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify({ type: 'file-request', tabId: id }))
      } catch (e) {}
    })
    await page.evaluateOnNewDocument((name) => {
      document.addEventListener('click', (e) => {
        try {
          let el = e.target
          while (el) {
            if (el.tagName === 'INPUT' && el.type === 'file') {
              try { window[name]() } catch (e) {}
              break
            }
            el = el.parentElement
          }
        } catch (e) {}
      }, true)
      document.addEventListener('focusin', (e) => {
        try {
          const el = e.target
          if (el && el.tagName === 'INPUT' && el.type === 'file') {
            try { window[name]() } catch (e) {}
          }
        } catch (e) {}
      })
    }, `__fileInputActivated_${id}`)
    tab.cdp.on('Page.screencastFrame', async (event) => {
      const now = Date.now()
      await tab.cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId })
      if (session.activeTabId !== tab.id) return
      if (now - tab.lastFrameTs < FRAME_INTERVAL_MS) return
      if (tab.sendingFrame) return
      tab.lastFrameTs = now
      try {
        const buf = Buffer.from(event.data, 'base64')
        tab.sendingFrame = true
        session.ws.send(buf, { binary: true }, () => { tab.sendingFrame = false })
      } catch (e) {
        tab.sendingFrame = false
      }
    })
    page.on('response', async (response) => {
      try {
        const headers = response.headers()
        const cd = headers['content-disposition'] || headers['Content-Disposition']
        if (cd && /attachment/i.test(cd)) {
          let filename = 'download'
          const m1 = cd.match(/filename\*=UTF-8''([^;]+)/)
          const m2 = cd.match(/filename="?([^";]+)"?/)
          if (m1) filename = decodeURIComponent(m1[1])
          else if (m2) filename = m2[1]
          const mime = headers['content-type'] || 'application/octet-stream'
          const buffer = await response.buffer()
          const size = buffer.length
          const safeName = filename.replace(/[^a-zA-Z0-9._-]/g,'_')
          const id = makeId()
          const localPath = path.join(downloadsDir, `${Date.now()}-${id}-${safeName}`)
          fs.writeFileSync(localPath, buffer)
          const token = id
          downloadTokens.set(token, { path: localPath, filename, mime, size, savedAt: Date.now() })
          if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({ type: 'download-offer', token, filename, mime, size }))
          }
        }
      } catch (e) {}
    })
    session.tabs.set(id, tab)
    if (url) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
      } catch (e) {}
    }
    return tab
  }
  async function startScreencastForTab(session, tab) {
    if (!tab || !tab.cdp) return
    try {
      await tab.cdp.send('Page.startScreencast', { format: 'jpeg', quality: JPEG_QUALITY, everyNthFrame: 1 })
    } catch (e) {}
  }
  async function stopScreencastForTab(tab) {
    if (!tab || !tab.cdp) return
    try {
      await tab.cdp.send('Page.stopScreencast')
    } catch (e) {}
  }
  wss.on('connection', async (ws) => {
    const connId = makeId()
    const session = { id: connId, ws, tabs: new Map(), activeTabId: null, lastUserActivityTs: Date.now(), warnSent: false }
    connections[connId] = session
    try {
      const saved = loadSessionState()
      const startUrl = saved.url || 'https://www.google.com'
      const firstTab = await createTabForSession(session, startUrl)
      session.activeTabId = firstTab.id
      await startScreencastForTab(session, firstTab)
      ws.send(JSON.stringify({ type: 'init', width: VIEWPORT.width, height: VIEWPORT.height, maxFps: MAX_FPS, connId, tabs: Array.from(session.tabs.keys()), activeTabId: session.activeTabId, audioAvailable }))
      ws.on('message', async (msg) => {
        session.lastUserActivityTs = Date.now()
        try {
          let text = null
          if (typeof msg === 'string') text = msg
          else if (msg instanceof Buffer) text = msg.toString()
          else if (msg instanceof ArrayBuffer) text = Buffer.from(msg).toString()
          else text = String(msg)
          const data = JSON.parse(text)
          const activeTab = session.tabs.get(session.activeTabId)
          if (data.type === 'mouse') {
            const tab = session.tabs.get(data.tabId || session.activeTabId) || activeTab
            if (!tab) return
            const x = Math.round(data.x)
            const y = Math.round(data.y)
            if (data.action === 'move') {
              tab.page.mouse.move(x, y).catch(() => {})
            } else if (data.action === 'down') {
              await tab.page.mouse.move(x, y)
              await tab.page.mouse.down({ button: data.button || 'left', clickCount: data.clickCount || 1 })
            } else if (data.action === 'up') {
              await tab.page.mouse.move(x, y)
              await tab.page.mouse.up({ button: data.button || 'left', clickCount: data.clickCount || 1 })
            } else if (data.action === 'click') {
              await tab.page.mouse.move(x, y)
              await tab.page.mouse.click(x, y, { button: data.button || 'left', clickCount: data.clickCount || 1 })
            }
          } else if (data.type === 'scroll') {
            const tab = session.tabs.get(data.tabId || session.activeTabId) || activeTab
            if (!tab) return
            const dx = Number(data.deltaX || 0)
            const dy = Number(data.deltaY || data.delta || 0)
            try {
              await tab.page.mouse.wheel({ deltaX: dx, deltaY: dy })
            } catch (e) {}
            try {
              await tab.page.evaluate((a,b) => {
                const cx = Math.floor(window.innerWidth/2)
                const cy = Math.floor(window.innerHeight/2)
                const target = document.elementFromPoint(cx, cy) || document.body
                target.dispatchEvent(new WheelEvent('wheel', { deltaX: a, deltaY: b, bubbles: true, cancelable: true }))
              }, dx, dy)
            } catch (e) {}
            try {
              const pos = await tab.page.evaluate(() => ({scrollX: window.scrollX, scrollY: window.scrollY}))
              const st = loadSessionState()
              st.scrollX = pos.scrollX
              st.scrollY = pos.scrollY
              saveSessionState(st)
            } catch (e) {}
          } else if (data.type === 'keyboard') {
            const tab = session.tabs.get(data.tabId || session.activeTabId) || activeTab
            if (!tab) return
            if (data.action === 'press') {
              await tab.page.keyboard.press(String(data.key || ''), { delay: data.delay || 0 })
            } else if (data.action === 'type') {
              await tab.page.keyboard.type(String(data.text || ''), { delay: data.delay || 0 })
            } else if (data.action === 'down') {
              await tab.page.keyboard.down(String(data.key))
            } else if (data.action === 'up') {
              await tab.page.keyboard.up(String(data.key))
            }
          } else if (data.type === 'navigate') {
            const tab = session.tabs.get(data.tabId || session.activeTabId) || activeTab
            if (tab && typeof data.url === 'string') {
              try {
                await tab.page.goto(data.url, { waitUntil: 'networkidle2', timeout: 30000 })
              } catch (e) {}
              tab.url = data.url
              const st = loadSessionState()
              st.url = data.url
              st.scrollX = 0
              st.scrollY = 0
              saveSessionState(st)
              ws.send(JSON.stringify({ type: 'navigated', url: data.url, tabId: tab.id }))
            }
          } else if (data.type === 'resize') {
            const tab = session.tabs.get(data.tabId || session.activeTabId) || activeTab
            if (tab && data.width && data.height) {
              const w = Math.max(100, Math.round(Number(data.width)))
              const h = Math.max(100, Math.round(Number(data.height)))
              await tab.page.setViewport({ width: w, height: h })
              ws.send(JSON.stringify({ type: 'resizeAck', width: w, height: h }))
            }
          } else if (data.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }))
          } else if (data.type === 'newtab') {
            const url = data.url || 'about:blank'
            const tab = await createTabForSession(session, url)
            session.activeTabId = tab.id
            await startScreencastForTab(session, tab)
            const tabsList = Array.from(session.tabs.values()).map(t => ({ id: t.id, url: t.url }))
            ws.send(JSON.stringify({ type: 'tabs', tabs: tabsList, activeTabId: session.activeTabId }))
          } else if (data.type === 'switchtab') {
            const targetId = data.tabId
            if (targetId && session.tabs.has(targetId)) {
              session.activeTabId = targetId
              const tabsList = Array.from(session.tabs.values()).map(t => ({ id: t.id, url: t.url }))
              ws.send(JSON.stringify({ type: 'tabs', tabs: tabsList, activeTabId: session.activeTabId }))
            }
          } else if (data.type === 'closetab') {
            const targetId = data.tabId
            if (targetId && session.tabs.has(targetId)) {
              const tab = session.tabs.get(targetId)
              try {
                await tab.page.close()
              } catch (e) {}
              session.tabs.delete(targetId)
              if (session.activeTabId === targetId) {
                const remaining = Array.from(session.tabs.keys())
                if (remaining.length) {
                  session.activeTabId = remaining[0]
                } else {
                  const nt = await createTabForSession(session, 'https://www.google.com')
                  session.activeTabId = nt.id
                  await startScreencastForTab(session, nt)
                }
              }
              const tabsList = Array.from(session.tabs.values()).map(t => ({ id: t.id, url: t.url }))
              ws.send(JSON.stringify({ type: 'tabs', tabs: tabsList, activeTabId: session.activeTabId }))
            }
          } else if (data.type === 'download-accept') {
            const token = String(data.token || '')
            if (token && downloadTokens.has(token)) {
              const info = downloadTokens.get(token)
              if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
              }
            }
          }
        } catch (err) {
          try { ws.send(JSON.stringify({ type: 'error', message: String(err) })) } catch (e) {}
        }
      })
      ws.on('close', async () => {
        try {
          for (const tab of session.tabs.values()) {
            try { await tab.page.close() } catch (e) {}
          }
          delete connections[connId]
        } catch (e) {}
      })
      ws.on('error', async () => {
        try {
          for (const tab of session.tabs.values()) {
            try { await tab.page.close() } catch (e) {}
          }
          delete connections[connId]
        } catch (e) {}
      })
    } catch (err) {
      try { ws.send(JSON.stringify({ type: 'error', message: String(err) })) } catch (e) {}
      if (session && session.tabs) {
        for (const tab of session.tabs.values()) {
          try { await tab.page.close() } catch (e) {}
        }
      }
      delete connections[connId]
    }
  })
  app.get('/dev/state', (req, res) => {
    try {
      const st = loadSessionState()
      const stats = {
        pid: process.pid,
        chromePath,
        userDataDir,
        appPort: APP_PORT,
        platform: os.platform(),
        arch: os.arch(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        interfaces: prettyInterfaces(),
        connections: Object.keys(connections).length,
        tabs: Object.values(connections).reduce((acc, s) => acc + s.tabs.size, 0),
        audioAvailable,
        sessionState: st
      }
      res.json({ ok: true, stats })
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) })
    }
  })
  app.get('/dev/export', async (req, res) => {
    try {
      const wantFull = String(req.query.full || '0') === '1'
      const format = String(req.query.format || 'tar.gz')
      const includeSession = fs.existsSync(SESSION_FILE)
      const includeProfile = fs.existsSync(userDataDir)
      if (!includeSession && !includeProfile) return res.status(404).send('nothing to export')
      const filename = format === 'zip' ? 'exported_profile.zip' : 'exported_profile.tar.gz'
      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      broadcastAll({ type: 'export-start', filename, wantFull, format })
      if (Archiver) {
        try {
          let archive
          if (format === 'zip') {
            archive = Archiver('zip', { zlib: { level: 9 } })
          } else {
            archive = Archiver('tar', { gzip: true, gzipOptions: { level: 9 } })
          }
          archive.on('warning', (w) => {})
          archive.on('error', (err) => {})
          archive.on('progress', (progress) => {
            try {
              broadcastAll({ type: 'export-progress', processedBytes: progress.fsBytes || 0, entries: progress.entries || {} })
            } catch (e) {}
          })
          archive.on('end', () => {
            broadcastAll({ type: 'export-complete' })
          })
          archive.pipe(res)
          if (includeSession) {
            archive.file(SESSION_FILE, { name: path.posix.join('session_state', path.basename(SESSION_FILE)) })
          }
          if (includeProfile && wantFull) {
            archive.glob('**/*', {
              cwd: userDataDir,
              dot: true,
              ignore: [
                '**/SingletonLock',
                '**/SingletonSocket',
                '**/lockfile*',
                '**/GpuCache/**',
                '**/Crashpad/**',
                '**/Cache/**',
                '**/ShaderCache/**'
              ]
            }, { prefix: 'profile' })
          } else if (includeProfile) {
            const minimalPaths = [
              path.join(userDataDir, 'Default', 'Bookmarks'),
              path.join(userDataDir, 'Default', 'Preferences'),
              path.join(userDataDir, 'Default', 'Cookies'),
              path.join(userDataDir, 'Default', 'Local Extension Settings'),
              path.join(userDataDir, 'Default', 'Extensions'),
              path.join(userDataDir, 'Extensions'),
              path.join(userDataDir, 'Default', 'Network Action Predictor'),
              path.join(userDataDir, 'Default', 'History')
            ]
            for (const p of minimalPaths) {
              try {
                if (fs.existsSync(p)) {
                  const stat = fs.statSync(p)
                  if (stat.isDirectory()) {
                    archive.glob('**/*', { cwd: p, dot: true }, { prefix: path.posix.join('profile', path.relative(userDataDir, p)) })
                  } else {
                    const rel = path.posix.join('profile', path.relative(userDataDir, p))
                    archive.file(p, { name: rel })
                  }
                }
              } catch (e) {}
            }
          }
          await archive.finalize().catch(e => {})
          return
        } catch (e) {}
      }
      if (AdmZip) {
        try {
          const tmpZip = path.join(os.tmpdir(), `exported_profile_${Date.now()}.${format === 'zip' ? 'zip' : 'tar.gz'}`)
          const zip = new AdmZip()
          if (includeSession) zip.addLocalFile(SESSION_FILE, 'session_state')
          if (includeProfile) {
            if (wantFull) {
              zip.addLocalFolder(userDataDir, 'profile')
            } else {
              const minimalPaths = [
                path.join(userDataDir, 'Default', 'Bookmarks'),
                path.join(userDataDir, 'Default', 'Preferences'),
                path.join(userDataDir, 'Default', 'Cookies'),
                path.join(userDataDir, 'Extensions')
              ]
              for (const p of minimalPaths) {
                if (fs.existsSync(p)) {
                  const stat = fs.statSync(p)
                  if (stat.isDirectory()) zip.addLocalFolder(p, path.posix.join('profile', path.relative(userDataDir, p)))
                  else zip.addLocalFile(p, path.posix.join('profile', path.relative(userDataDir, path.dirname(p))))
                }
              }
            }
          }
          zip.writeZip(tmpZip)
          const stream = fs.createReadStream(tmpZip)
          stream.on('end', () => { try { fs.unlinkSync(tmpZip) } catch (e) {} })
          stream.pipe(res)
          broadcastAll({ type: 'export-complete' })
          return
        } catch (e) {}
      }
      res.status(500).send('No available archiving method on host (install archiver or adm-zip).')
    } catch (e) {
      try { if (!res.headersSent) res.status(500).send(String(e)) } catch (ee) {}
    }
  })
  app.post('/dev/import', uploadMw.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, message: 'no file uploaded' })
      const uploadedPath = req.file.path
      const tmpDir = path.join(os.tmpdir(), `import_${Date.now()}`)
      fs.mkdirSync(tmpDir, { recursive: true })
      const lower = uploadedPath.toLowerCase()
      let extracted = false
      let entriesCount = 0
      broadcastAll({ type: 'import-start', name: req.file.originalname })
      try {
        if ((lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) && Tar) {
          await Tar.x({
            file: uploadedPath,
            cwd: tmpDir,
            gzip: true,
            onentry: (entry) => {
              entriesCount++
              try { broadcastAll({ type: 'import-progress', entriesProcessed: entriesCount, name: entry.path }) } catch (e) {}
            },
            filter: (p) => {
              if (p.includes('..')) return false
              return true
            }
          })
          extracted = true
        } else if (lower.endsWith('.zip') && Unzipper) {
          await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(uploadedPath).pipe(Unzipper.Parse())
            stream.on('entry', (entry) => {
              entriesCount++
              try { broadcastAll({ type: 'import-progress', entriesProcessed: entriesCount, name: entry.path }) } catch (e) {}
              const filePath = path.join(tmpDir, entry.path)
              if (entry.type === 'Directory') {
                try { fs.mkdirSync(filePath, { recursive: true }) } catch (e) {}
                entry.autodrain()
              } else {
                const dir = path.dirname(filePath)
                try { fs.mkdirSync(dir, { recursive: true }) } catch (e) {}
                entry.pipe(fs.createWriteStream(filePath))
              }
            })
            stream.on('close', resolve)
            stream.on('error', reject)
          })
          extracted = true
        } else if (AdmZip) {
          const zip = new AdmZip(uploadedPath)
          const zipEntries = zip.getEntries()
          for (const ze of zipEntries) {
            entriesCount++
            try { broadcastAll({ type: 'import-progress', entriesProcessed: entriesCount, name: ze.entryName }) } catch (e) {}
          }
          zip.extractAllTo(tmpDir, true)
          extracted = true
        } else {
          const sp = spawnSync('tar', ['-xzf', uploadedPath, '-C', tmpDir], { timeout: 0 })
          if (sp.status === 0) extracted = true
        }
      } catch (e) {
        rimrafSync(tmpDir)
        try { fs.unlinkSync(uploadedPath) } catch (e2) {}
        broadcastAll({ type: 'import-error', message: String(e) })
        return res.status(500).json({ ok: false, message: 'extraction failed: ' + String(e) })
      }
      if (!extracted) {
        rimrafSync(tmpDir)
        try { fs.unlinkSync(uploadedPath) } catch (e) {}
        broadcastAll({ type: 'import-error', message: 'no extraction method available' })
        return res.status(500).json({ ok: false, message: 'no extraction method available' })
      }
      broadcastAll({ type: 'import-extracted', entries: entriesCount })
      let applied = { profile: false, session: false }
      try {
        if (browser) {
          try { await browser.close() } catch (e) {}
          browser = null
        }
      } catch (e) {}
      const extractedProfile = (function findProfileRoot(base) {
        if (!fs.existsSync(base)) return null
        const entries = fs.readdirSync(base)
        if (entries.includes('profile') && fs.statSync(path.join(base, 'profile')).isDirectory()) return path.join(base, 'profile')
        for (const e of entries) {
          const full = path.join(base, e)
          try {
            if (fs.statSync(full).isDirectory()) {
              const sub = fs.readdirSync(full)
              if (sub.includes('Default') || sub.includes('Preferences') || sub.includes('Bookmarks')) return full
            }
          } catch (ee) {}
        }
        return null
      })(tmpDir)
      if (extractedProfile && fs.existsSync(extractedProfile)) {
        try {
          try { rimrafSync(userDataDir) } catch (e) {}
          try {
            fs.renameSync(extractedProfile, userDataDir)
            applied.profile = true
          } catch (e) {
            try {
              const copyRecursive = (src, dest) => {
                const stat = fs.statSync(src)
                if (stat.isDirectory()) {
                  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true })
                  for (const f of fs.readdirSync(src)) copyRecursive(path.join(src, f), path.join(dest, f))
                } else {
                  const dir = path.dirname(dest)
                  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
                  fs.copyFileSync(src, dest)
                }
              }
              copyRecursive(extractedProfile, userDataDir)
              applied.profile = true
            } catch (err) {}
          }
        } catch (e) {}
      }
      const possible = []
      const walk = (base) => {
        const stack = [base]
        while (stack.length) {
          const cur = stack.pop()
          try {
            const entries = fs.readdirSync(cur)
            for (const e of entries) {
              const full = path.join(cur, e)
              const st = fs.statSync(full)
              if (st.isDirectory()) stack.push(full)
              else if (e.toLowerCase() === 'session_state.json') possible.push(full)
            }
          } catch (e) {}
        }
      }
      walk(tmpDir)
      if (possible.length) {
        try {
          fs.copyFileSync(possible[0], SESSION_FILE)
          applied.session = true
        } catch (e) {}
      }
      try { fs.unlinkSync(uploadedPath) } catch (e) {}
      rimrafSync(tmpDir)
      try {
        browser = await puppeteer.launch(launchOptions)
      } catch (e) {
        broadcastAll({ type: 'import-finish', ok: true, message: 'import applied but browser restart failed. Please restart server manually.', applied })
        return res.json({ ok: true, message: 'import applied but browser restart failed. Please restart the server manually.', applied })
      }
      broadcastAll({ type: 'import-finish', ok: true, message: 'import applied and browser restarted', applied })
      res.json({ ok: true, message: 'import applied and browser restarted', applied })
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) })
    }
  })
  app.post('/dev/start-audio', (req, res) => {
    try {
      startAudioCapture()
      res.json({ ok: true, audioAvailable })
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) })
    }
  })
  app.post('/dev/stop-audio', (req, res) => {
    try {
      stopAudioCapture()
      res.json({ ok: true, audioAvailable })
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) })
    }
  })
  server.listen(APP_PORT, '0.0.0.0', () => {
    const addr = server.address()
    console.log(`Server listening on http://${addr.address}:${addr.port}`)
    console.log(`PID: ${process.pid}`)
    console.log(`WS endpoint ws://${addr.address}:${addr.port}/ws`)
    console.log(`Audio WS endpoint ws://${addr.address}:${addr.port}/audio`)
  }).on('error', (err) => {
    console.error('Failed to bind server:', err)
    process.exit(1)
  })
  process.on('SIGINT', async () => {
    try { broadcastAll({ type: 'server-shutdown', message: 'server is shutting down' }) } catch (e) {}
    try { for (const c of Object.values(connections)) { try { c.ws.send(JSON.stringify({ type: 'warning', message: 'Server shutting down' })) } catch (e) {} } } catch (e) {}
    try { if (ffmpegProcess) ffmpegProcess.kill() } catch (e) {}
    try { if (browser) await browser.close() } catch (e) {}
    setTimeout(() => process.exit(0), 250)
  })
  process.on('SIGTERM', async () => {
    try { broadcastAll({ type: 'server-shutdown', message: 'server is shutting down' }) } catch (e) {}
    try { for (const c of Object.values(connections)) { try { c.ws.send(JSON.stringify({ type: 'warning', message: 'Server shutting down' })) } catch (e) {} } } catch (e) {}
    try { if (ffmpegProcess) ffmpegProcess.kill() } catch (e) {}
    try { if (browser) await browser.close() } catch (e) {}
    setTimeout(() => process.exit(0), 250)
  })
}
start().catch((err) => {
  console.error(err)
  process.exit(1)
})
