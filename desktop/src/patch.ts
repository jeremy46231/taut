// Taut Desktop Patch
// Mutates the cached CJS electron module before Slack's asar loads so every
// subsequent require('electron') from Slack's code gets our patched versions.
// Also spoofs the process/app env properties Slack uses to locate its assets.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { app, ipcMain, Menu, shell } from 'electron'

const cjsRequire = createRequire(import.meta.url)
const NodeModule = cjsRequire('module') as any
const electronCjs = cjsRequire('electron') as Record<string, any>

// intercept Module._load so that any require('electron') from Slack's code returns our Proxy
const overrides: Record<string, any> = {}
const electronProxy = new Proxy(electronCjs, {
  get(target, prop: string) {
    return prop in overrides ? overrides[prop] : target[prop]
  },
})
const origModuleLoad = NodeModule._load
NodeModule._load = function (request: string, ...args: any[]) {
  if (request === 'electron') return electronProxy
  return origModuleLoad.call(this, request, ...args)
}

// Taut menu

let openOptionsWindowFn: (() => void) | null = null

export function setOpenOptionsWindow(fn: () => void) {
  openOptionsWindowFn = fn
}

const tautMenuTemplate: Electron.MenuItemConstructorOptions = {
  label: 'Taut',
  submenu: [
    {
      label: 'About Taut',
      click: () => shell.openExternal('https://github.com/jeremy46231/taut'),
    },
    {
      label: 'Change App Source...',
      click: () => openOptionsWindowFn?.(),
    },
    { type: 'separator' },
    { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Alt+I' },
    { role: 'reload' },
    { role: 'forceReload' },
    { type: 'separator' },
    { role: 'quit' },
  ],
}

function injectTautMenu(
  items: (Electron.MenuItem | Electron.MenuItemConstructorOptions)[]
) {
  const out = [...items]
  const helpIdx = out.findIndex((i) => (i as Electron.MenuItem).role === 'help')
  helpIdx !== -1
    ? out.splice(helpIdx, 0, tautMenuTemplate)
    : out.push(tautMenuTemplate)
  return out
}

// BrowserWindow proxy

export function applyPatches(slackAsarPath: string, tautPreloadPath: string) {
  const slackResourcesPath = path.dirname(slackAsarPath)

  let originalPreloadContents: string | null = null
  ipcMain.handle('taut:get-original-preload', () => originalPreloadContents)

  const OrigBrowserWindow = electronCjs.BrowserWindow
  overrides.BrowserWindow = new Proxy(OrigBrowserWindow, {
    construct(Target: any, [opts = {}]: any[]) {
      console.log('[Taut] BrowserWindow created')
      const origPreload: string | undefined = opts.webPreferences?.preload
      if (origPreload && originalPreloadContents === null) {
        try {
          originalPreloadContents = readFileSync(origPreload, 'utf8')
          console.log('[Taut] Cached Slack preload from:', origPreload)
        } catch (e) {
          console.error('[Taut] Failed to read Slack preload:', e)
        }
      }
      return new Target({
        ...opts,
        webPreferences: {
          ...opts.webPreferences,
          preload: tautPreloadPath,
          devTools: true,
        },
      })
    },
  })

  // Menu: inject Taut submenu
  const origSetAppMenu = electronCjs.Menu.setApplicationMenu.bind(
    electronCjs.Menu
  )
  electronCjs.Menu.setApplicationMenu = (menu: Electron.Menu | null) => {
    if (!menu) return origSetAppMenu(menu)
    return origSetAppMenu(Menu.buildFromTemplate(injectTautMenu(menu.items)))
  }
  const origSetMenu = OrigBrowserWindow.prototype.setMenu
  OrigBrowserWindow.prototype.setMenu = function (menu: Electron.Menu | null) {
    if (!menu) return origSetMenu.call(this, menu)
    return origSetMenu.call(
      this,
      Menu.buildFromTemplate(injectTautMenu(menu.items))
    )
  }

  // may have to run before resourcesPath is spoofed?
  if (process.platform === 'darwin') {
    app.setAsDefaultProtocolClient('slack')
    console.log('[Taut] Registered as slack:// handler')
  }

  const pendingUrls: string[] = []
  let replaying = false
  const origOn = app.on.bind(app)
  const origOnce = app.once.bind(app)
  const origEmit = app.emit.bind(app)

  function replayPending() {
    if (replaying || !pendingUrls.length) return
    replaying = true
    try {
      console.log(
        `[Taut] Replaying ${pendingUrls.length} queued open-url event(s) to Slack handler`
      )
      while (pendingUrls.length)
        origEmit('open-url', { preventDefault() {} }, pendingUrls.shift())
    } finally {
      replaying = false
    }
  }

  app.on = (event: any, listener: any) => {
    const result = origOn(event, listener)
    if (event === 'open-url') process.nextTick(replayPending)
    return result
  }
  app.once = (event: any, listener: any) => {
    const result = origOnce(event, listener)
    if (event === 'open-url') process.nextTick(replayPending)
    return result
  }

  const captureListener = (event: any, url: string) => {
    console.log(`[Taut] open-url fired: ${url}`)
    if (event?.preventDefault) event.preventDefault()
    if (replaying) return
    // Once Slack has registered its own handler, stop capturing
    if (app.listeners('open-url').some((l) => l !== captureListener)) return
    pendingUrls.push(url)
  }
  origOn('open-url', captureListener)

  // Environment: make Slack think it's running from its own bundle
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: slackResourcesPath,
  })
  app.getAppPath = () => slackAsarPath
  app.setPath('userData', path.join(app.getPath('appData'), 'Slack'))
}
