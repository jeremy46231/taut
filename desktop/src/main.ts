// Taut Desktop Main Process
// Orchestrates startup: loads prefs, patches electron, sets up session/bridge, loads Slack

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  Notification,
  protocol,
  session,
} from 'electron'
import {
  installExtension,
  REACT_DEVELOPER_TOOLS,
} from 'electron-devtools-installer'
import { setupBridge } from './bridge.js'
import { applyPatches, setOpenOptionsWindow } from './patch.js'
import { getAppUrl, getNotifPrompted, loadPrefs, savePrefs } from './prefs.js'
import { setupSession } from './session.js'
import { findSlackAsar } from './slackFinder.js'

const cjsRequire = createRequire(import.meta.url)

declare const __TAUT_EMBEDDED__: boolean

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Save real resourcesPath before patch.ts spoofs it
const realResourcesPath = process.resourcesPath

await loadPrefs()

if (__TAUT_EMBEDDED__) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'taut',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ])
}

let slackAsarPath: string
try {
  slackAsarPath = findSlackAsar()
} catch {
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'Taut',
      message: 'Slack could not be found',
      detail: 'Install the official Slack app, then open Taut again.',
      buttons: ['Quit'],
    })
    app.exit(1)
  })
  process.exit(1)
}

function openOptionsWindow() {
  const optionsPreload = path.join(__dirname, 'options-preload.js')
  const optionsHtml = path.join(__dirname, 'options.html')

  const win = new BrowserWindow({
    width: 480,
    height: 260,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Taut Options',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: optionsPreload,
      contextIsolation: true,
    },
  })
  win.loadFile(optionsHtml)
  win.setMenu(null)
}

setOpenOptionsWindow(openOptionsWindow)

applyPatches(slackAsarPath, path.join(__dirname, 'preload.js'))

function requestNotificationPermission() {
  try {
    if (!Notification.isSupported()) return
    if (getNotifPrompted()) return
    const notification = new Notification({
      title: 'Taut',
      body: 'Notifications are enabled! Manage them in System Settings > Notifications.',
    })
    notification.show()
    savePrefs({ notifPrompted: true })
  } catch (e: any) {
    console.error('[Taut] Notification permission request failed:', e.message)
  }
}

app.whenReady().then(async () => {
  requestNotificationPermission()
  setupSession(realResourcesPath)

  try {
    await installExtension(REACT_DEVELOPER_TOOLS)
    // Workaround for https://github.com/electron/electron/issues/41613
    const extensions = (
      session.defaultSession as any
    ).extensions.getAllExtensions() as any[]
    for (const ext of extensions) {
      if (
        ext.manifest?.manifest_version === 3 &&
        ext.manifest?.background?.service_worker
      ) {
        await (
          session.defaultSession as any
        ).serviceWorkers.startWorkerForScope(ext.url)
      }
    }
    console.log('[Taut] React Developer Tools installed')
  } catch (err) {
    console.error('[Taut] Failed to install React Developer Tools:', err)
  }
})

setupBridge(
  {
    configDir: path.join(app.getPath('appData'), 'Taut'),
  },
  {
    getAppUrl,
    setAppUrl: (url: string) => savePrefs({ appUrl: url }),
    openOptionsWindow,
  }
)

// Handle slack:// URLs passed as CLI args
const slackArgUrl = process.argv.find((a) => a.startsWith('slack://'))
if (slackArgUrl) {
  app.whenReady().then(() => {
    console.log(
      `[Taut] slack:// URL in argv, emitting open-url: ${slackArgUrl}`
    )
    app.emit('open-url', { preventDefault() {} }, slackArgUrl)
  })
}

process.on('uncaughtException', (err) => {
  console.error('[Taut] Uncaught exception:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[Taut] Unhandled rejection:', reason)
})
app.on('before-quit', (_e) => {
  console.log('[Taut] App quitting (before-quit fired)')
})
app.on('window-all-closed', () => {
  console.log('[Taut] All windows closed')
})

// Load Slack
console.log(`[Taut] Loading Slack from ${slackAsarPath}`)
try {
  cjsRequire(slackAsarPath)
} catch (err) {
  console.error('[Taut] Failed to load Slack:', err)
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'Taut',
      message: 'Failed to load Slack',
      detail: String(err),
      buttons: ['Quit'],
    })
    app.exit(1)
  })
}
