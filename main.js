'use strict'
/**
 * DeepSeek Harness Desktop — main process (clean-room implementation).
 *
 * This file is original code written for this project. It implements the
 * documented behaviour contract of the shell (frameless window + sandboxed
 * WebContentsView, bundled-harness spawn with URL-line discovery, navigation
 * allow-list, window-control IPC, QA hooks) plus the mobile-remote features:
 *
 *   - Tray-owned lifecycle: closing the window hides it and keeps the local
 *     Harness running so a phone can keep controlling it.
 *   - "Phone remote access" switch: writes a user-level profile patch that
 *     binds the webserver to 0.0.0.0, restarts the Host, and exposes the LAN
 *     URL + QR code in a small remote window.
 *   - Graceful shutdown: SIGTERM with a bounded grace period, then SIGKILL.
 *
 * Behaviour contract (kept stable so QA and packaging acceptance stay valid):
 *   - 42px custom title bar in a frameless BrowserWindow; official UI is
 *     attached as a sandboxed WebContentsView below it.
 *   - The bundled Node runtime spawns `@deepseek-ai/dsh web` with
 *     DSH_HOME=<userData>/harness-home; loopback mode uses `--port 0`,
 *     remote mode relies on the webserver profile patch (CLI `--host` is
 *     intentionally unsupported upstream).
 *   - Navigation is confined to the harness origin; external http(s) URLs go
 *     to the system browser; new windows / webviews are refused.
 *   - IPC: `desktop:window-control` (minimize | toggle-maximize | close),
 *     `desktop:get-window-state`, events `desktop:window-state` and
 *     `desktop:page-title`; every handler verifies the sender.
 *   - QA hooks: DSH_DESKTOP_QA_SCREENSHOT, DSH_DESKTOP_QA_WINDOW_CONTROLS=1,
 *     DSH_DESKTOP_QA_AUTO_QUIT=1.
 *   - Logs append to <userData>/logs/desktop.log.
 */

const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  ipcMain,
  dialog,
  shell,
  desktopCapturer,
  Tray,
  nativeImage,
  clipboard,
} = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const qrcode = require('qrcode-generator')

const PRODUCT_NAME = 'DeepSeek Harness Desktop'
const TITLE_BAR_HEIGHT = 42
const HARNESS_START_TIMEOUT_MS = 90_000
const HARNESS_SHUTDOWN_TIMEOUT_MS = 5_000
const REMOTE_DEFAULT_PORT = 8787
const URL_LINE_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/i
const LAN_URL_PATTERN = /\(LAN:\s+(https?:\/\/[^\s)]+)\)/i

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const state = {
  window: null,        // BrowserWindow (the shell)
  view: null,          // WebContentsView (harness UI)
  remoteWindow: null,  // small settings window for phone remote access
  tray: null,
  harness: null,       // HarnessProcess handle
  harnessOrigin: null, // parsed origin of the running harness
  lanUrl: null,        // LAN URL printed by dsh when remote mode is enabled
  startupTimer: null,
  quitting: false,
  quitReleased: false,
  suppressHarnessExitDialog: false,
  remoteEnabled: false,
  remotePort: REMOTE_DEFAULT_PORT,
  remoteBusy: false,
  remoteError: null,
  quitPromise: null,
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function dataPath(...segments) {
  return path.join(app.getPath('userData'), ...segments)
}

function appendLog(message) {
  try {
    const dir = dataPath('logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'desktop.log'), `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // Logging must never prevent startup.
  }
}

// ---------------------------------------------------------------------------
// Bundled harness management
// ---------------------------------------------------------------------------

/** Bundled Node binary name: `node.exe` on Windows, `node` on macOS. */
function bundledNodeBinaryName() {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

/**
 * Owns the bundled `@deepseek-ai/dsh` child process: locate, spawn, discover
 * the loopback URL, and stop with a bounded grace period.
 */
class HarnessProcess {
  constructor() {
    this.child = null
    this.runtimeDir = null
  }

  runtimeRoot() {
    // Packaged builds carry harness under resources; dev runs use the repo copy.
    return app.isPackaged
      ? path.join(process.resourcesPath, 'harness')
      : path.join(__dirname, 'harness')
  }

  locate() {
    this.runtimeDir = this.runtimeRoot()
    const cliPath = path.join(this.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const nodePath = path.join(this.runtimeDir, 'runtime', bundledNodeBinaryName())
    if (!fs.existsSync(cliPath)) {
      throw new Error(`Bundled Harness CLI was not found: ${cliPath}`)
    }
    if (!fs.existsSync(nodePath)) {
      throw new Error(`Bundled Node.js runtime was not found: ${nodePath}`)
    }
    return { cliPath, nodePath }
  }

  async start() {
    const { cliPath, nodePath } = this.locate()
    const harnessHome = dataPath('harness-home')
    // Never start Harness in the user's entire home directory: dsh treats its
    // launch cwd as the default workspace root, so confine it to userData.
    const harnessWorkspace = dataPath('harness-home', 'workspace')
    fs.mkdirSync(harnessWorkspace, { recursive: true })

    state.lanUrl = null
    appendLog(`Starting Harness from ${cliPath} with ${nodePath}`)
    appendLog(`[desktop] Harness workspace: ${harnessWorkspace}`)
    appendLog(`[desktop] Remote access mode: ${state.remoteEnabled ? `enabled (port ${state.remotePort})` : 'disabled'}`)

    // Loopback mode asks dsh for an OS-assigned port. Remote mode relies on
    // the webserver profile patch (host 0.0.0.0 + fixed port), so no `--port`
    // argument may override the patch.
    const cliArgs = state.remoteEnabled
      ? [cliPath, 'web']
      : [cliPath, 'web', '--port', '0']

    this.child = spawn(nodePath, cliArgs, {
      cwd: harnessWorkspace,
      env: {
        ...process.env,
        DSH_HOME: harnessHome,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    return this.discoverUrl()
  }

  /** Resolve the harness URLs from output lines, bounded by the startup budget. */
  discoverUrl() {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, url) => {
        if (settled) return
        settled = true
        clearTimeout(state.startupTimer)
        state.startupTimer = null
        if (error) reject(error)
        else resolve(url)
      }

      const onChunk = (source, chunk) => {
        // Strip ANSI escapes before scanning (dsh may colourise its output).
        const text = chunk.toString('utf8').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
        for (const rawLine of text.split(/\r?\n/)) {
          const line = rawLine.trim()
          if (!line) continue
          appendLog(`[dsh:${source}] ${line}`)

          const localHit = line.match(URL_LINE_PATTERN)
          if (localHit) {
            state.harnessOrigin = new URL(localHit[0]).origin
            finish(undefined, localHit[0])
          }

          const lanHit = line.match(LAN_URL_PATTERN)
          if (lanHit) {
            state.lanUrl = lanHit[1]
            appendLog(`[desktop] LAN address available: ${state.lanUrl}`)
            broadcastRemoteState()
          }
        }
      }

      this.child.stdout.on('data', chunk => onChunk('out', chunk))
      this.child.stderr.on('data', chunk => onChunk('err', chunk))

      this.child.once('error', error => {
        appendLog(`[dsh:error] ${error.stack || error.message}`)
        finish(error)
      })

      this.child.once('exit', (code, signal) => {
        appendLog(`[dsh:exit] code=${code} signal=${signal}`)
        this.child = null
        if (!settled) {
          finish(new Error(`Harness exited during startup (code=${code}, signal=${signal})`))
        } else if (!state.quitting && !state.suppressHarnessExitDialog
          && state.window && !state.window.isDestroyed()) {
          void dialog.showMessageBox(state.window, {
            type: 'error',
            title: 'Harness service stopped',
            message: 'The DeepSeek Harness background service exited unexpectedly.',
            detail: `Exit code: ${code ?? 'unknown'}\nLogs: ${dataPath('logs')}`,
          })
        }
      })

      state.startupTimer = setTimeout(() => {
        finish(new Error(`Harness startup exceeded ${HARNESS_START_TIMEOUT_MS / 1000} seconds.`))
      }, HARNESS_START_TIMEOUT_MS)
    })
  }

  /** Stop the child with a bounded SIGTERM grace period, escalating to SIGKILL. */
  stop(timeoutMs = HARNESS_SHUTDOWN_TIMEOUT_MS) {
    clearTimeout(state.startupTimer)
    state.startupTimer = null
    const child = this.child
    if (!child || child.killed) {
      this.child = null
      return Promise.resolve()
    }
    return new Promise(resolve => {
      let finished = false
      let escalationTimer = null
      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(escalationTimer)
        this.child = null
        resolve()
      }
      appendLog(`[desktop] Stopping Harness pid=${child.pid}`)
      escalationTimer = setTimeout(() => {
        appendLog(`[desktop] Harness did not exit within ${timeoutMs}ms; escalating to SIGKILL`)
        try {
          child.kill('SIGKILL')
        } catch (error) {
          appendLog(`[desktop] Failed to escalate Harness shutdown: ${error.message}`)
        }
      }, timeoutMs)
      child.once('exit', finish)
      try {
        child.kill('SIGTERM')
      } catch (error) {
        appendLog(`[desktop] Failed to stop Harness: ${error.message}`)
        finish()
      }
      if (child.exitCode !== null || child.signalCode !== null) finish()
    })
  }
}

// ---------------------------------------------------------------------------
// Phone remote access (webserver profile patch)
// ---------------------------------------------------------------------------

function remotePatchFilePath() {
  return dataPath('harness-home', 'profiles', 'web', 'cordis.patch.yml')
}

function webserverPatchEntry(port) {
  return [
    '- id: webserver',
    '  config:',
    '    host: 0.0.0.0',
    `    port: ${port}`,
  ].join('\n')
}

/** Parse the id-targeted patch list into per-entry strings (other plugins preserved). */
function parsePatchEntries(content) {
  const entries = []
  let current = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (/^- id:/.test(line) && current.length > 0) {
      entries.push(current.join('\n'))
      current = []
    }
    if (line.trim() !== '') current.push(line)
  }
  if (current.length > 0) entries.push(current.join('\n'))
  return entries
}

function writeRemotePatch(enabled, port) {
  const file = remotePatchFilePath()
  let entries = []
  if (fs.existsSync(file)) {
    entries = parsePatchEntries(fs.readFileSync(file, 'utf8'))
  }
  entries = entries.filter(entry => !/^- id:\s*webserver\s*$/.test(entry))
  if (enabled) entries.push(webserverPatchEntry(port))

  if (entries.length === 0) {
    fs.rmSync(file, { force: true })
    appendLog(`[desktop] Remote patch removed: ${file}`)
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${entries.join('\n\n')}\n`, 'utf8')
  appendLog(`[desktop] Remote patch written: ${file}`)
}

function loadRemoteProfile() {
  const file = remotePatchFilePath()
  if (!fs.existsSync(file)) return
  const entries = parsePatchEntries(fs.readFileSync(file, 'utf8'))
  const webserver = entries.find(entry => /^- id:\s*webserver\s*$/.test(entry))
  if (!webserver) return
  const portMatch = webserver.match(/port:\s*(\d+)/)
  if (!portMatch) return
  state.remoteEnabled = true
  state.remotePort = Number(portMatch[1]) || REMOTE_DEFAULT_PORT
  appendLog(`[desktop] Loaded remote profile: 0.0.0.0:${state.remotePort}`)
}

function qrSvgDataUrl(text) {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const svg = qr.createSvgTag({ cellSize: 6, margin: 2 })
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function remoteStatePayload() {
  const url = state.remoteEnabled && state.lanUrl ? state.lanUrl : null
  return {
    enabled: state.remoteEnabled,
    port: state.remotePort,
    url,
    qrDataUrl: url ? qrSvgDataUrl(url) : null,
    busy: state.remoteBusy,
    error: state.remoteError,
  }
}

function broadcastRemoteState() {
  const payload = remoteStatePayload()
  for (const target of [state.window?.webContents, state.remoteWindow?.webContents]) {
    if (target && !target.isDestroyed()) target.send('desktop:remote-state', payload)
  }
}

async function probeRenderer() {
  if (!state.view || state.view.webContents.isDestroyed()) return
  const probe = await state.view.webContents.executeJavaScript(`({
    title: document.title,
    readyState: document.readyState,
    bodyTextLength: document.body?.innerText?.length ?? 0,
  })`)
  appendLog(`[desktop] Renderer ready ${JSON.stringify(probe)}`)
}

async function applyRemoteEnabled(enabled, port) {
  if (state.remoteBusy) throw new Error('远程访问设置正在生效，请稍候')
  state.remoteBusy = true
  state.remoteError = null
  broadcastRemoteState()
  try {
    writeRemotePatch(enabled, port)
    state.remoteEnabled = enabled
    state.remotePort = port
    state.suppressHarnessExitDialog = true
    if (state.harness) await state.harness.stop()
    state.harness = new HarnessProcess()
    const url = await state.harness.start()
    appendLog(`[desktop] Loading ${url}`)
    if (state.view && !state.view.webContents.isDestroyed()) {
      await state.view.webContents.loadURL(url)
    } else {
      await attachContentView(url)
    }
    await probeRenderer()
    state.suppressHarnessExitDialog = false
  } catch (error) {
    state.remoteError = error.message
    appendLog(`[desktop:error] Failed to apply remote access setting: ${error.stack || error.message}`)
    // Roll the profile patch back and bring the loopback Host up again so the
    // desktop stays usable after a failed remote-mode switch.
    try {
      writeRemotePatch(false, port)
      state.remoteEnabled = false
      state.suppressHarnessExitDialog = true
      if (state.harness) await state.harness.stop()
      state.harness = new HarnessProcess()
      const url = await state.harness.start()
      if (state.view && !state.view.webContents.isDestroyed()) {
        await state.view.webContents.loadURL(url)
      } else if (state.window && !state.window.isDestroyed()) {
        await attachContentView(url)
      }
      await probeRenderer()
      appendLog('[desktop] Remote-mode rollback completed; loopback Host restored')
    } catch (restoreError) {
      appendLog(`[desktop:error] Remote-mode rollback failed: ${restoreError.message}`)
    } finally {
      state.suppressHarnessExitDialog = false
    }
    throw error
  } finally {
    state.remoteBusy = false
    broadcastRemoteState()
  }
}

function openRemoteWindow() {
  if (state.remoteWindow && !state.remoteWindow.isDestroyed()) {
    state.remoteWindow.show()
    state.remoteWindow.focus()
    return
  }
  state.remoteWindow = new BrowserWindow({
    width: 440,
    height: 640,
    minWidth: 440,
    minHeight: 640,
    resizable: false,
    title: '手机远程访问',
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  state.remoteWindow.removeMenu()
  state.remoteWindow.on('closed', () => {
    state.remoteWindow = null
  })
  void state.remoteWindow.loadFile(path.join(__dirname, 'remote.html'))
}

// ---------------------------------------------------------------------------
// Navigation guard
// ---------------------------------------------------------------------------

function isHarnessUrl(rawUrl) {
  if (!state.harnessOrigin) return false
  try {
    return new URL(rawUrl).origin === state.harnessOrigin
  } catch {
    return false
  }
}

function routeExternalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      appendLog(`[desktop] Blocked external protocol: ${parsed.protocol}`)
      return
    }
    void shell.openExternal(parsed.toString())
  } catch {
    appendLog('[desktop] Blocked malformed external URL.')
  }
}

function guardNavigation(webContents) {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isHarnessUrl(url)) {
      void webContents.loadURL(url)
    } else {
      routeExternalUrl(url)
    }
    return { action: 'deny' }
  })

  webContents.on('will-navigate', (event, url) => {
    if (isHarnessUrl(url)) return
    event.preventDefault()
    routeExternalUrl(url)
  })

  webContents.on('will-attach-webview', event => event.preventDefault())
}

// ---------------------------------------------------------------------------
// Window construction
// ---------------------------------------------------------------------------

function pushWindowState() {
  if (!state.window || state.window.isDestroyed()) return
  state.window.webContents.send('desktop:window-state', {
    maximized: state.window.isMaximized(),
    fullScreen: state.window.isFullScreen(),
  })
}

function layoutContentView() {
  if (!state.window || state.window.isDestroyed() || !state.view) return
  const [width, height] = state.window.getContentSize()
  state.view.setBounds({
    x: 0,
    y: TITLE_BAR_HEIGHT,
    width: Math.max(0, width),
    height: Math.max(0, height - TITLE_BAR_HEIGHT),
  })
}

async function attachContentView(url) {
  state.view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (typeof state.view.setBackgroundColor === 'function') {
    state.view.setBackgroundColor('#ffffff')
  }

  state.window.contentView.addChildView(state.view)
  layoutContentView()
  guardNavigation(state.view.webContents)

  state.view.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault()
    const nextTitle = title?.trim() || PRODUCT_NAME
    state.window?.setTitle(nextTitle)
    state.window?.webContents.send('desktop:page-title', nextTitle)
  })

  state.view.webContents.on('render-process-gone', (_event, details) => {
    appendLog(`[desktop] Harness renderer gone: ${JSON.stringify(details)}`)
  })

  await state.view.webContents.loadURL(url)
}

async function createWindow() {
  state.window = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    thickFrame: true,
    roundedCorners: true,
    hasShadow: true,
    resizable: true,
    maximizable: true,
    minimizable: true,
    closable: true,
    icon: path.join(__dirname, 'build', 'deepseek-harness.svg'),
    backgroundColor: '#f6f7f9',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  state.window.removeMenu()
  state.window.setMenuBarVisibility(false)

  state.window.on('resize', layoutContentView)
  for (const eventName of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    state.window.on(eventName, pushWindowState)
  }
  state.window.on('close', event => {
    // Tray-owned lifecycle: an ordinary close hides the window and keeps the
    // Host running. During an explicit quit the close is allowed through.
    if (!state.quitting && state.tray) {
      event.preventDefault()
      state.window.hide()
      appendLog('[desktop] Window hidden to tray; Harness keeps running')
    }
  })
  state.window.on('closed', () => {
    state.view = null
    state.window = null
  })
  state.window.once('ready-to-show', () => state.window?.show())

  await state.window.loadFile(path.join(__dirname, 'shell.html'))
  pushWindowState()

  try {
    state.harness = new HarnessProcess()
    const url = await state.harness.start()
    appendLog(`[desktop] Loading ${url}`)
    await attachContentView(url)
    await probeRenderer()

    const screenshotTarget = process.env.DSH_DESKTOP_QA_SCREENSHOT
    if (screenshotTarget) await captureScreenshot(screenshotTarget)

    if (process.env.DSH_DESKTOP_QA_REMOTE === '1') await exerciseRemoteAccess()

    if (process.env.DSH_DESKTOP_QA_WINDOW_CONTROLS === '1') await exerciseWindowControls()

    if (process.env.DSH_DESKTOP_QA_AUTO_QUIT === '1') scheduleAutoQuit()
  } catch (error) {
    appendLog(`[desktop:error] ${error.stack || error.message}`)
    if (state.window && !state.window.isDestroyed()) {
      await dialog.showMessageBox(state.window, {
        type: 'error',
        title: 'Startup failed',
        message: 'DeepSeek Harness could not be started.',
        detail: `${error.message}\n\nLogs: ${dataPath('logs')}`,
      })
    }
    void requestAppQuit()
  }
}

function showMainWindow() {
  if (state.quitting || !state.window || state.window.isDestroyed()) return
  if (state.window.isMinimized()) state.window.restore()
  state.window.show()
  state.window.focus()
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function trayIcon() {
  const iconPath = path.join(__dirname, 'build', 'icon.png')
  const source = nativeImage.createFromPath(iconPath)
  if (source.isEmpty()) return nativeImage.createEmpty()
  const size = process.platform === 'darwin' ? 18 : 16
  const resized = source.resize({ width: size, height: size, quality: 'best' })
  if (process.platform === 'darwin') resized.setTemplateImage(true)
  return resized
}

function createTray() {
  try {
    const icon = trayIcon()
    if (icon.isEmpty()) {
      appendLog('[desktop] Tray icon unavailable; window close will quit the app')
      return
    }
    state.tray = new Tray(icon)
    state.tray.setToolTip(PRODUCT_NAME)
    state.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => showMainWindow() },
      { label: '手机远程访问', click: () => openRemoteWindow() },
      { type: 'separator' },
      { label: '退出', click: () => void requestAppQuit() },
    ]))
    state.tray.on('click', () => showMainWindow())
    appendLog('[desktop] Tray created')
  } catch (error) {
    state.tray = null
    appendLog(`[desktop] Tray creation failed: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// QA hooks
// ---------------------------------------------------------------------------

/**
 * Capture the composed window (title bar + harness view) to a PNG.
 *
 * macOS 10.15+ requires the user to grant Screen Recording permission before
 * desktopCapturer can produce window thumbnails. An unattended machine may not
 * have that grant, so the screenshot QA step is recorded as skipped on macOS
 * instead of failing the whole run; the window-controls QA still covers the
 * automated smoke test.
 */
async function captureScreenshot(filename) {
  await new Promise(resolve => setTimeout(resolve, 2_000))
  const target = path.resolve(filename)
  fs.mkdirSync(path.dirname(target), { recursive: true })

  try {
    const bounds = state.window.getBounds()
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: {
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height),
      },
      fetchWindowIcons: false,
    })

    const source = sources.find(item => item.name === state.window.getTitle())
      ?? sources.find(item => /DeepSeek Harness/i.test(item.name))

    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('The composed Electron window was not available to desktopCapturer.')
    }

    fs.writeFileSync(target, source.thumbnail.toPNG())
    appendLog(`[desktop] QA screenshot saved to ${target}`)
  } catch (error) {
    if (process.platform === 'darwin') {
      appendLog(`[desktop] macOS screen capture unavailable; QA screenshot skipped: ${error.message}`)
      return
    }
    throw error
  }
}

function waitForWindow(predicate, description, timeoutMs = 5_000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (!state.window || state.window.isDestroyed()) {
        reject(new Error(`Window was destroyed while waiting for ${description}.`))
        return
      }
      if (predicate(state.window)) {
        resolve()
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${description}.`))
        return
      }
      setTimeout(poll, 50)
    }
    poll()
  })
}

async function clickShellButton(buttonId) {
  const clicked = await state.window.webContents.executeJavaScript(`(() => {
    const el = document.getElementById(${JSON.stringify(buttonId)})
    if (!el) return false
    el.click()
    return true
  })()`)
  if (!clicked) throw new Error(`Title-bar button was not found: ${buttonId}`)
}

async function exerciseWindowControls() {
  if (state.window.isMaximized()) state.window.unmaximize()
  if (state.window.isMinimized()) state.window.restore()

  await clickShellButton('maximize')
  await waitForWindow(w => w.isMaximized(), 'the custom maximize action')

  await clickShellButton('maximize')
  await waitForWindow(w => !w.isMaximized(), 'the custom restore action')

  await clickShellButton('minimize')
  await waitForWindow(w => w.isMinimized(), 'the custom minimize action')

  state.window.restore()
  state.window.show()
  await waitForWindow(w => !w.isMinimized(), 'the restored test window')

  appendLog('[desktop] Window controls QA passed: maximize, restore, minimize')
}

async function exerciseRemoteAccess() {
  appendLog('[desktop] Remote access QA: enabling LAN mode...')
  await applyRemoteEnabled(true, state.remotePort)
  if (!state.lanUrl) {
    appendLog('[desktop] Remote access QA skipped: dsh did not report a LAN URL')
    await applyRemoteEnabled(false, state.remotePort)
    return
  }
  appendLog(`[desktop] Remote access QA: LAN URL ${state.lanUrl}`)
  await applyRemoteEnabled(false, state.remotePort)
  appendLog('[desktop] Remote access QA passed: enable, LAN discovery, disable')
}

function scheduleAutoQuit() {
  const controlsWereExercised = process.env.DSH_DESKTOP_QA_WINDOW_CONTROLS === '1'
  if (controlsWereExercised) {
    appendLog('[desktop] Testing the custom close action')
    setTimeout(() => {
      if (!state.window || state.window.isDestroyed()) return
      void clickShellButton('close').catch(error => {
        appendLog(`[desktop:error] Custom close QA failed: ${error.message}`)
        void requestAppQuit()
      })
    }, 250)
  } else {
    setTimeout(() => void requestAppQuit(), 250)
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function isTrustedSender(event) {
  return event.sender === state.window?.webContents
    || event.sender === state.remoteWindow?.webContents
}

function registerWindowIpc() {
  ipcMain.on('desktop:window-control', (event, action) => {
    if (!state.window || state.window.isDestroyed()) return
    if (event.sender !== state.window.webContents) return
    switch (action) {
      case 'minimize':
        state.window.minimize()
        break
      case 'toggle-maximize':
        if (state.window.isMaximized()) state.window.unmaximize()
        else state.window.maximize()
        break
      case 'close': {
        const qaClose = process.env.DSH_DESKTOP_QA_WINDOW_CONTROLS === '1'
          && process.env.DSH_DESKTOP_QA_AUTO_QUIT === '1'
        if (qaClose) void requestAppQuit()
        else state.window.close()
        break
      }
      default:
        break
    }
  })

  ipcMain.on('desktop:open-remote', event => {
    if (event.sender !== state.window?.webContents) return
    openRemoteWindow()
  })

  ipcMain.handle('desktop:get-window-state', event => {
    if (!state.window || state.window.isDestroyed()) return { maximized: false, fullScreen: false }
    if (event.sender !== state.window.webContents) return { maximized: false, fullScreen: false }
    return {
      maximized: state.window.isMaximized(),
      fullScreen: state.window.isFullScreen(),
    }
  })

  ipcMain.handle('desktop:remote-get-state', event => {
    if (!isTrustedSender(event)) throw new Error('Untrusted remote-access request')
    return remoteStatePayload()
  })

  ipcMain.handle('desktop:remote-set-enabled', async (event, enabled, port) => {
    if (!isTrustedSender(event)) throw new Error('Untrusted remote-access request')
    const requestedPort = enabled
      ? (Number.isInteger(Number(port)) ? Number(port) : REMOTE_DEFAULT_PORT)
      : state.remotePort
    if (enabled && (requestedPort < 1024 || requestedPort > 65535)) {
      throw new Error('端口必须在 1024-65535 之间')
    }
    await applyRemoteEnabled(Boolean(enabled), requestedPort)
    return remoteStatePayload()
  })

  ipcMain.handle('desktop:copy-text', (event, text) => {
    if (!isTrustedSender(event)) return false
    clipboard.writeText(String(text ?? ''))
    return true
  })
}

// ---------------------------------------------------------------------------
// Application menu (platform difference)
// ---------------------------------------------------------------------------

function configureApplicationMenu() {
  // Windows keeps a frameless window with no menu. macOS needs a minimal
  // application menu so the standard shortcuts (Cmd+Q, Cmd+C/V/X, Cmd+M)
  // keep working in the shell and in the harness content view.
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: PRODUCT_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]))
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function requestAppQuit() {
  if (state.quitting) return state.quitPromise
  state.quitting = true
  appendLog('[desktop] Quit requested; stopping Harness before exit')
  state.quitPromise = (async () => {
    if (state.remoteWindow && !state.remoteWindow.isDestroyed()) state.remoteWindow.close()
    if (state.harness) await state.harness.stop()
  })().catch(error => {
    appendLog(`[desktop:error] Shutdown failed: ${error.message}`)
  }).finally(() => {
    if (state.quitReleased) return
    state.quitReleased = true
    state.tray?.destroy()
    state.tray = null
    app.quit()
  })
  return state.quitPromise
}

registerWindowIpc()

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
  app.on('activate', () => showMainWindow())

  app.on('window-all-closed', () => {
    // The tray (and the Host) own the application lifetime. If no tray could
    // be created, fall back to the traditional quit-on-last-window behaviour
    // so the process never becomes unreachable.
    if (!state.tray && !state.quitting) app.quit()
  })

  app.on('before-quit', event => {
    if (state.quitReleased) return
    event.preventDefault()
    void requestAppQuit()
  })

  app.whenReady().then(async () => {
    app.setName(PRODUCT_NAME)
    if (process.platform === 'win32') {
      app.setAppUserModelId('ai.deepseek.harness.desktop.unofficial')
    }
    if (process.platform === 'darwin' && app.dock) {
      const dockIcon = path.join(__dirname, 'build', 'icon.png')
      if (fs.existsSync(dockIcon)) app.dock.setIcon(dockIcon)
    }
    configureApplicationMenu()
    loadRemoteProfile()
    createTray()
    await createWindow()
  }).catch(error => {
    appendLog(`[desktop:fatal] ${error.stack || error.message}`)
    dialog.showErrorBox('Startup failed', error.message)
    void requestAppQuit()
  })
}
