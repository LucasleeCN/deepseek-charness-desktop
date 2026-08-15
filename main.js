'use strict'
/**
 * DeepSeek Harness Desktop — main process (clean-room implementation).
 *
 * This file is original code written for this project. It implements the same
 * documented behaviour contract as the upstream reference shell (frameless
 * window + sandboxed WebContentsView, bundled-harness spawn with URL-line
 * discovery, navigation allow-list, window-control IPC, QA hooks) but with an
 * independent internal design.
 *
 * Behaviour contract (kept stable so QA and packaging acceptance stay valid):
 *   - 42px custom title bar in a frameless BrowserWindow; official UI is
 *     attached as a sandboxed WebContentsView below it.
 *   - The bundled Node runtime spawns `@deepseek-ai/dsh web --port 0` with
 *     DSH_HOME=<userData>/harness-home; the loopback URL is parsed from
 *     stdout/stderr within a 90s budget.
 *   - Navigation is confined to the harness origin; external http(s) URLs go
 *     to the system browser; new windows / webviews are refused.
 *   - IPC: `desktop:window-control` (minimize | toggle-maximize | close),
 *     `desktop:get-window-state`, events `desktop:window-state` and
 *     `desktop:page-title`; every handler verifies the sender.
 *   - QA hooks: DSH_DESKTOP_QA_SCREENSHOT, DSH_DESKTOP_QA_WINDOW_CONTROLS=1,
 *     DSH_DESKTOP_QA_AUTO_QUIT=1.
 *   - Logs append to <userData>/logs/desktop.log.
 */

const { app, BrowserWindow, WebContentsView, Menu, ipcMain, dialog, shell, desktopCapturer } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const PRODUCT_NAME = 'DeepSeek Harness Desktop'
const TITLE_BAR_HEIGHT = 42
const HARNESS_START_TIMEOUT_MS = 90_000
const URL_LINE_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/i

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const state = {
  window: null,       // BrowserWindow (the shell)
  view: null,         // WebContentsView (harness UI)
  harness: null,      // HarnessProcess handle
  harnessOrigin: null, // parsed origin of the running harness
  startupTimer: null,
  quitting: false,
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
 * the loopback URL, and stop.
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
    // Review fix: never start Harness in the user's entire home directory.
    // dsh treats its launch cwd as the default workspace root, so confine it
    // to a dedicated directory under userData.
    const harnessWorkspace = dataPath('harness-home', 'workspace')
    fs.mkdirSync(harnessWorkspace, { recursive: true })

    appendLog(`Starting Harness from ${cliPath} with ${nodePath}`)
    appendLog(`[desktop] Harness workspace: ${harnessWorkspace}`)

    this.child = spawn(nodePath, [cliPath, 'web', '--port', '0'], {
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

  /** Resolve the harness URL from output lines, bounded by the startup budget. */
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
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) appendLog(`[dsh:${source}] ${line}`)
        }
        const hit = text.match(URL_LINE_PATTERN)
        if (hit) {
          state.harnessOrigin = new URL(hit[0]).origin
          finish(undefined, hit[0])
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
        } else if (!state.quitting && state.window && !state.window.isDestroyed()) {
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

  stop() {
    clearTimeout(state.startupTimer)
    state.startupTimer = null
    if (!this.child || this.child.killed) return
    appendLog(`[desktop] Stopping Harness pid=${this.child.pid}`)
    try {
      this.child.kill()
    } catch (error) {
      appendLog(`[desktop] Failed to stop Harness: ${error.message}`)
    }
  }
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

    // Readiness probe: used by CI and by the QA hooks below.
    const probe = await state.view.webContents.executeJavaScript(`({
      title: document.title,
      readyState: document.readyState,
      bodyTextLength: document.body?.innerText?.length ?? 0,
    })`)
    appendLog(`[desktop] Renderer ready ${JSON.stringify(probe)}`)

    const screenshotTarget = process.env.DSH_DESKTOP_QA_SCREENSHOT
    if (screenshotTarget) await captureScreenshot(screenshotTarget)

    if (process.env.DSH_DESKTOP_QA_WINDOW_CONTROLS === '1') await exerciseWindowControls()

    if (process.env.DSH_DESKTOP_QA_AUTO_QUIT === '1') scheduleAutoQuit()
  } catch (error) {
    appendLog(`[desktop:error] ${error.stack || error.message}`)
    await dialog.showMessageBox(state.window, {
      type: 'error',
      title: 'Startup failed',
      message: 'DeepSeek Harness could not be started.',
      detail: `${error.message}\n\nLogs: ${dataPath('logs')}`,
    })
    app.quit()
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

function scheduleAutoQuit() {
  const controlsWereExercised = process.env.DSH_DESKTOP_QA_WINDOW_CONTROLS === '1'
  if (controlsWereExercised) {
    appendLog('[desktop] Testing the custom close action')
    setTimeout(() => {
      if (!state.window || state.window.isDestroyed()) return
      void clickShellButton('close').catch(error => {
        appendLog(`[desktop:error] Custom close QA failed: ${error.message}`)
        app.quit()
      })
    }, 250)
  } else {
    setTimeout(() => app.quit(), 250)
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

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
      case 'close':
        state.window.close()
        break
      default:
        break
    }
  })

  ipcMain.handle('desktop:get-window-state', event => {
    if (!state.window || state.window.isDestroyed()) return { maximized: false, fullScreen: false }
    if (event.sender !== state.window.webContents) return { maximized: false, fullScreen: false }
    return {
      maximized: state.window.isMaximized(),
      fullScreen: state.window.isFullScreen(),
    }
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

registerWindowIpc()

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!state.window) return
    if (state.window.isMinimized()) state.window.restore()
    state.window.show()
    state.window.focus()
  })

  app.whenReady().then(() => {
    app.setName(PRODUCT_NAME)
    if (process.platform === 'win32') {
      app.setAppUserModelId('ai.deepseek.harness.desktop.unofficial')
    }
    if (process.platform === 'darwin' && app.dock) {
      const dockIcon = path.join(__dirname, 'build', 'icon.png')
      if (fs.existsSync(dockIcon)) app.dock.setIcon(dockIcon)
    }
    configureApplicationMenu()
    return createWindow()
  }).catch(error => {
    appendLog(`[desktop:fatal] ${error.stack || error.message}`)
    dialog.showErrorBox('Startup failed', error.message)
    app.quit()
  })
}

app.on('before-quit', () => {
  state.quitting = true
  state.harness?.stop()
})

app.on('window-all-closed', () => app.quit())
