import { once } from 'node:events'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app, autoUpdater as nativeUpdater, webContents } from 'electron'
import type { AppUpdater, UpdateInfo } from 'electron-updater'
import { DESKTOP_FEED_URL, DESKTOP_UPDATE_CHANNELS } from '../../shared/updates'
import { getInstall, installerArch } from './installType.js'
import { cachedSlackAsar, downloadSlack } from './slackDownload.js'

declare const __TAUT_EMBEDDED__: boolean

const CHECK_INTERVAL = 4 * 60 * 60 * 1000
// captured before patch.ts points resourcesPath at Slack's
const realResourcesPath = process.resourcesPath

const logger = {
  info: (message: unknown) => console.log('[Taut] Updater:', message),
  warn: (message: unknown) => console.warn('[Taut] Updater:', message),
  error: (message: unknown) => console.error('[Taut] Updater:', message),
}

/** an update being downloaded, `done` settles when electron-updater has it */
export interface Update {
  version: string
  done: Promise<void>
}

let starting: Promise<boolean> | null = null
let updater: AppUpdater | null = null
let ready: string | null = null
let checking: Promise<Update | null> | null = null
let downloading: Update | null = null

/** the downloaded version a restart would install, if any */
export const readyUpdate = () => ready

function markReady(version: string) {
  ready = version
  console.log(`[Taut] Update ${version} is ready`)
  for (const contents of webContents.getAllWebContents()) {
    contents.send('taut:update-ready', version)
  }
}

/** resolves to whether this copy updates itself */
export function startAutoUpdate(): Promise<boolean> {
  starting ??= setUpUpdater()
  return starting
}

async function setUpUpdater(): Promise<boolean> {
  if (__TAUT_EMBEDDED__) return false
  const install = await getInstall()
  if (!install.canSelfUpdate) return false
  // written by electron-builder, names the updater's cache dir
  const config = path.join(realResourcesPath, 'app-update.yml')
  if (!existsSync(config)) {
    console.warn(`[Taut] ${config} is missing, not updating by itself`)
    return false
  }
  try {
    // not the default `autoUpdater`, on linux it reads resources/package-type and picks the sudo package updaters
    const { AppImageUpdater, MacUpdater, NsisUpdater } = await import(
      'electron-updater'
    )
    const Updater =
      install.type === 'nsis'
        ? NsisUpdater
        : install.type === 'mac'
          ? MacUpdater
          : AppImageUpdater
    const instance = new Updater()
    instance.logger = logger
    instance.updateConfigPath = config
    // Slack comes first, see checkForUpdate
    instance.autoDownload = false
    instance.setFeedURL({
      provider: 'generic',
      // dev only, e.g. a local server with a test build's files
      url: process.env.TAUT_UPDATE_URL || DESKTOP_FEED_URL,
      channel: DESKTOP_UPDATE_CHANNELS[install.platform].channel,
      // GitHub's asset storage doesn't answer multipart range requests
      useMultipleRangeRequest: false,
    })
    if (install.type === 'mac') {
      // Squirrel.Mac still has to take the zip from electron-updater
      let downloaded: string | null = null
      instance.on('update-downloaded', (info: UpdateInfo) => {
        downloaded = info.version
      })
      nativeUpdater.on('update-downloaded', () => {
        if (downloaded) markReady(downloaded)
      })
    } else {
      instance.on('update-downloaded', (info: UpdateInfo) =>
        markReady(info.version)
      )
    }
    updater = instance
  } catch (err) {
    console.warn('[Taut] Self-update unavailable:', err)
    return false
  }
  const check = () =>
    checkForUpdate()
      .then((update) => update?.done)
      .catch((err) => console.warn('[Taut] Update failed:', err))
  check()
  setInterval(check, CHECK_INTERVAL)
  return true
}

/** the Slack an update pins, fetched beside the running one */
async function fetchUpdateSlack(info: UpdateInfo) {
  const version = (info as { vendor?: { slackVersion?: unknown } }).vendor
    ?.slackVersion
  if (typeof version !== 'string' || !/^\d+(\.\d+)*$/.test(version)) return
  // an x64 copy under arm64 emulation updates to the arm64 build
  const arch = installerArch()
  if (cachedSlackAsar(version, arch)) return
  await downloadSlack(undefined, version, arch)
}

async function download(current: AppUpdater, info: UpdateInfo) {
  try {
    // a restart into the update shouldn't have to download Slack first
    await fetchUpdateSlack(info)
    await current.downloadUpdate()
  } finally {
    downloading = null
  }
}

/** checks the feed and starts the download, resolves to the update downloading, if any */
export function checkForUpdate(): Promise<Update | null> {
  const current = updater
  if (!current || ready) return Promise.resolve(null)
  if (downloading) return Promise.resolve(downloading)
  checking ??= (async () => {
    try {
      const result = await current.checkForUpdates()
      if (!result?.isUpdateAvailable) return null
      const { updateInfo } = result
      downloading = {
        version: updateInfo.version,
        done: download(current, updateInfo),
      }
      return downloading
    } finally {
      checking = null
    }
  })()
  return checking
}

/** resolves once a restart would install `update` */
export async function updateReady(update: Update): Promise<void> {
  await update.done
  if (ready || process.platform !== 'darwin') return
  // rejects on the error event, which is how Squirrel.Mac reports a failure
  await once(nativeUpdater, 'update-downloaded')
}

export function restartToUpdate() {
  const current = updater
  if (!current || !ready) return
  console.log(`[Taut] Restarting into ${ready}`)
  // Slack only closes its windows when quitting, and this will-quit runs before Slack's, which exits
  app.once('will-quit', (event) => {
    event.preventDefault()
    current.quitAndInstall(true, true)
  })
  app.quit()
}
