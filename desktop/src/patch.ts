// Taut Desktop Patch: gives Slack's require('electron') a patched proxy and spoofs the paths Slack uses to find its assets

import { EventEmitter } from 'node:events'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { app, ipcMain, Menu, MenuItem, shell } from 'electron'
import { redirectNativeModules } from './nativeModules.js'
import { configDir } from './paths.js'
import { checkForUpdates } from './updates.js'

declare const __TAUT_EMBEDDED__: boolean

const cjsRequire = createRequire(import.meta.url)
const NodeModule = cjsRequire('module') as any
const electronCjs = cjsRequire('electron') as Record<string, any>

// only Slack's require('electron') gets this proxy, Taut's own dependencies get the real module
const overrides: Record<string, any> = {}
const electronProxy = new Proxy(electronCjs, {
  get(target, prop: string) {
    return prop in overrides ? overrides[prop] : target[prop]
  },
})

// Slack's app.asar paths, set before Slack loads
let slackAsars: string[] = []
function isSlackModule(parent: { filename?: unknown } | undefined) {
  const file = parent?.filename
  if (typeof file !== 'string') return false
  return slackAsars.some((asar) => {
    const rel = path.relative(asar, file)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  })
}

// Slack reads MDM prefs through cf-prefs, forced AutoUpdate off drops its update menu items and polling
let cfPrefsShim: object | null = null
function shimCfPrefs(real: Record<string, any>) {
  const forcedPrefs: Record<string, unknown> = { AutoUpdate: false }
  const forced = (key: string) => Object.hasOwn(forcedPrefs, key)
  cfPrefsShim ??= new Proxy(real, {
    get(target, prop) {
      if (prop === 'isPreferenceForced') {
        return (key: string) => forced(key) || target.isPreferenceForced(key)
      }
      if (prop === 'getPreferenceValue') {
        return (key: string) =>
          forced(key) ? forcedPrefs[key] : target.getPreferenceValue(key)
      }
      return target[prop as string]
    },
  })
  return cfPrefsShim
}

const origModuleLoad = NodeModule._load
NodeModule._load = function (request: string, parent: any, ...args: any[]) {
  if (request === 'electron' && isSlackModule(parent)) return electronProxy
  const loaded = origModuleLoad.call(this, request, parent, ...args)
  if (request === 'cf-prefs' && process.platform === 'darwin') {
    return shimCfPrefs(loaded)
  }
  return loaded
}

class NoopAutoUpdater extends EventEmitter {
  setFeedURL() {}
  getFeedURL() {
    return ''
  }
  checkForUpdates() {
    this.emit('checking-for-update')
    process.nextTick(() => this.emit('update-not-available'))
  }
  quitAndInstall() {
    app.quit()
  }
}
overrides.autoUpdater = new NoopAutoUpdater()
overrides.crashReporter = {
  start() {},
  getLastCrashReport: () => null,
  getUploadedReports: () => [],
  getUploadToServer: () => false,
  setUploadToServer() {},
  addExtraParameter() {},
  removeExtraParameter() {},
  getParameters: () => ({}),
}

let openOptionsWindowFn: (() => void) | null = null

export function setOpenOptionsWindow(fn: () => void) {
  openOptionsWindowFn = fn
}

// embedded builds carry their own copy and don't get updates
const updateItems: Electron.MenuItemConstructorOptions[] = __TAUT_EMBEDDED__
  ? []
  : [
      {
        id: 'taut-check-for-updates',
        label: 'Check for Updates…',
        click: () => checkForUpdates(),
      },
    ]

const tautMenuTemplate: Electron.MenuItemConstructorOptions = {
  id: 'taut',
  label: 'Taut',
  submenu: [
    {
      label: 'About Taut',
      click: () => shell.openExternal('https://github.com/jeremy46231/taut'),
    },
    {
      label: 'Change App Source…',
      click: () => openOptionsWindowFn?.(),
    },
    ...updateItems,
    { type: 'separator' },
    { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Alt+I' },
    { role: 'reload' },
    { role: 'forceReload' },
    { type: 'separator' },
    { role: 'quit' },
  ],
}

function tautMenuIndex(menu: Electron.Menu) {
  const { items } = menu
  if (items.some((i) => i.id === 'taut')) return -1
  const helpIdx = items.findIndex((i) => i.role === 'help')
  return helpIdx === -1 ? items.length : helpIdx
}

// forcing AutoUpdate off removes Slack's item after About in the mac app menu, so ours replaces it
function addAppMenuUpdateItems(menu: Electron.Menu) {
  const submenu = menu.items.find((i) => i.id === 'menucategory-slack')?.submenu
  if (!submenu || submenu.items.some((i) => i.id === 'taut-check-for-updates'))
    return
  const about = submenu.items.findIndex((i) => i.id === 'menuitem-about-slack')
  for (const [i, item] of updateItems.entries()) {
    submenu.insert(about + 1 + i, new MenuItem(item))
  }
}

function withTautMenu(menu: Electron.Menu) {
  addAppMenuUpdateItems(menu)
  const idx = tautMenuIndex(menu)
  if (idx === -1) return menu
  const { items } = menu
  return Menu.buildFromTemplate([
    ...items.slice(0, idx),
    tautMenuTemplate,
    ...items.slice(idx),
  ])
}

// only Slack's app menu has `menucategory-*` top-level items
const isSlackAppMenu = (menu: Electron.Menu) =>
  menu.items.some((i) => i.id?.startsWith('menucategory-'))

export function applyPatches(slackAsarPath: string, tautPreloadPath: string) {
  const slackResourcesPath = path.dirname(slackAsarPath)
  // module filenames are realpaths
  slackAsars = [path.resolve(slackAsarPath)]
  try {
    slackAsars.push(realpathSync(slackAsarPath))
  } catch {}
  redirectNativeModules(slackResourcesPath)

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

  const origSetAppMenu = electronCjs.Menu.setApplicationMenu.bind(
    electronCjs.Menu
  )
  electronCjs.Menu.setApplicationMenu = (menu: Electron.Menu | null) =>
    origSetAppMenu(menu && withTautMenu(menu))
  const origSetMenu = OrigBrowserWindow.prototype.setMenu
  OrigBrowserWindow.prototype.setMenu = function (menu: Electron.Menu | null) {
    return origSetMenu.call(this, menu && withTautMenu(menu))
  }
  // the Windows title bar menu button pops up Slack's reused app menu object instead of the window menu
  const origPopup = electronCjs.Menu.prototype.popup
  electronCjs.Menu.prototype.popup = function (
    this: Electron.Menu,
    ...args: Parameters<Electron.Menu['popup']>
  ) {
    if (isSlackAppMenu(this)) addAppMenuUpdateItems(this)
    const idx = isSlackAppMenu(this) ? tautMenuIndex(this) : -1
    if (idx !== -1) this.insert(idx, new MenuItem(tautMenuTemplate))
    return origPopup.apply(this, args)
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
    // stop capturing once Slack registers its own handler
    if (app.listeners('open-url').some((l) => l !== captureListener)) return
    pendingUrls.push(url)
  }
  origOn('open-url', captureListener)

  // make Slack think it's running from its own bundle
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: slackResourcesPath,
  })
  app.getAppPath = () => slackAsarPath
  app.setPath('userData', path.join(configDir(), 'profile'))
}
