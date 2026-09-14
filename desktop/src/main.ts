// Taut Desktop Main Process
// Orchestrates startup: loads prefs, patches electron, sets up session/bridge, loads Slack

import { execFileSync } from 'node:child_process'
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
import { installAppImageDesktopEntry } from './appImage.js'
import { setupBridge } from './bridge.js'
import { applyPatches, setOpenOptionsWindow } from './patch.js'
import { configDir } from './paths.js'
import {
  getAppUrl,
  getNotifPrompted,
  getSigning,
  loadPrefs,
  savePrefs,
} from './prefs.js'
import { setupSession } from './session.js'
import {
  cachedSlackAsar,
  downloadSlack,
  downloadSlackNatives,
  downloadSlackWithWindow,
} from './slackDownload.js'
import { findInstalledSlackAsar } from './slackFinder.js'

const cjsRequire = createRequire(import.meta.url)

declare const __TAUT_EMBEDDED__: boolean
declare const __TAUT_APP_ID__: string
/** see signingMarker in scripts/lib/macSigning.ts */
declare const __TAUT_MAC_SIGNING__: string

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Save real resourcesPath before patch.ts spoofs it
const realResourcesPath = process.resourcesPath

// don't touch global stuff like slack://, .desktop, etc
const temporary = process.env.TAUT_TEMPORARY === '1'

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

function resolveSlackAsar(): string | undefined {
  const override = process.env.TAUT_SLACK_ASAR
  if (override) return override
  const cached = cachedSlackAsar()
  if (cached) return cached
  const installed = findInstalledSlackAsar()
  if (installed) {
    app
      .whenReady()
      .then(() =>
        downloadSlack().catch((err) =>
          console.warn('[Taut] Background Slack download failed:', err)
        )
      )
  }
  return installed
}

const slackAsarPath = resolveSlackAsar()
if (slackAsarPath) {
  startSlack(slackAsarPath)
} else {
  // first launch, can't find slack
  app.whenReady().then(async () => {
    await downloadSlackWithWindow()
    // slack has to run before the app is ready
    app.relaunch()
    app.exit(0)
  })
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
      scrollBounce: true
    },
  })
  win.loadFile(optionsHtml)
  win.setMenu(null)
}

function startSlack(slackAsarPath: string) {
  setOpenOptionsWindow(openOptionsWindow)

  if (!temporary) {
    // the desktop entry has to exist before xdg is asked to route slack:// to it
    void installAppImageDesktopEntry().then(() => {
      const ok = app.setAsDefaultProtocolClient('slack')
      console.log(
        ok
          ? '[Taut] Registered as slack:// handler'
          : '[Taut] Failed to register as slack:// handler'
      )
    })
  }
  applyPatches(slackAsarPath, path.join(__dirname, 'preload.js'))

  app
    .whenReady()
    .then(() =>
      downloadSlackNatives(path.dirname(slackAsarPath)).catch((err) =>
        console.warn('[Taut] arm64 slack-desktop-utils download failed:', err)
      )
    )

  function requestNotificationPermission() {
    try {
      if (temporary) return
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

  function resetStaleMacPermissions() {
    if (process.platform !== 'darwin' || temporary) return
    const previous = getSigning()
    if (previous === __TAUT_MAC_SIGNING__) return
    if (getNotifPrompted()) {
      console.log(
        `[Taut] Signature changed (${previous ?? 'unknown'} -> ${__TAUT_MAC_SIGNING__}), resetting macOS permissions`
      )
      try {
        execFileSync('tccutil', ['reset', 'All', __TAUT_APP_ID__], {
          stdio: 'inherit',
        })
      } catch (e: any) {
        console.error('[Taut] Permission reset failed:', e.message)
      }
    }
    savePrefs({ signing: __TAUT_MAC_SIGNING__ })
  }

  app.whenReady().then(async () => {
    resetStaleMacPermissions()
    requestNotificationPermission()
    setupSession(realResourcesPath)

    if (process.env.TAUT_REACT_DEVTOOLS !== '1') return

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
      configDir: configDir(),
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
}
