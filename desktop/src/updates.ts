import { clipboard, dialog, net, shell } from 'electron'
import {
  compareVersions,
  desktopDownload,
  INSTALL_HELP_URL,
  updateCommand,
  VERSIONS_URL,
  type VersionsFile,
} from '../../shared/updates'
import {
  checkForUpdate,
  readyUpdate,
  restartToUpdate,
  startAutoUpdate,
  type Update,
  updateReady,
} from './autoUpdate.js'
import { getInstall } from './installType.js'

declare const __TAUT_LOADER_VERSION__: string

let waiting: { update: Update; shown: AbortController } | null = null

async function offerRestart(ready: string) {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: `Taut ${ready} is ready`,
    buttons: ['Restart', 'Later'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) restartToUpdate()
}

const upToDate = (current: string) =>
  dialog.showMessageBox({
    type: 'info',
    message: "You're up to date",
    detail: `Taut ${current} is the newest version.`,
  })

async function selfUpdate(current: string) {
  let update: Update | null
  try {
    update = await checkForUpdate()
  } catch (err) {
    await dialog.showMessageBox({
      type: 'error',
      message: "Couldn't check for updates",
      detail: String(err),
    })
    return
  }
  if (!update) {
    const ready = readyUpdate()
    await (ready ? offerRestart(ready) : upToDate(current))
    return
  }
  const shown =
    waiting?.update === update ? waiting.shown : new AbortController()
  dialog.showMessageBox({
    type: 'info',
    message: `Downloading Taut ${update.version}`,
    detail: `You have ${current}. Taut will ask to restart once it's downloaded.`,
    signal: shown.signal,
  })
  if (waiting?.shown === shown) return
  waiting = { update, shown }
  const failure = await updateReady(update).then(
    () => null,
    (err: unknown) => String(err)
  )
  waiting = null
  shown.abort()
  if (failure !== null) {
    await dialog.showMessageBox({
      type: 'error',
      message: `Couldn't download Taut ${update.version}`,
      detail: failure,
    })
    return
  }
  const ready = readyUpdate()
  if (ready) await offerRestart(ready)
}

export async function checkForUpdates() {
  const current = __TAUT_LOADER_VERSION__
  const ready = readyUpdate()
  if (ready) return offerRestart(ready)
  if (await startAutoUpdate()) return selfUpdate(current)

  let versions: VersionsFile
  try {
    const response = await net.fetch(VERSIONS_URL, { cache: 'no-cache' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    versions = await response.json()
  } catch (err) {
    await dialog.showMessageBox({
      type: 'error',
      message: "Couldn't check for updates",
      detail: String(err),
    })
    return
  }

  const install = await getInstall()
  const desktop = versions.loaders.electron
  const latest = desktop.platforms[install.platform]?.version
  if (!latest || compareVersions(current, latest) >= 0) {
    await upToDate(current)
    return
  }

  const command = updateCommand(install.type)
  const file = command
    ? null
    : desktopDownload(install.type, install.platform, desktop)
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: `Taut ${latest} is available`,
    detail: command
      ? `You have ${current}. To update, run:\n\n${command}`
      : `You have ${current}.`,
    buttons: [
      command ? 'Copy Command' : file ? 'Download' : 'How to Update',
      'Later',
    ],
    defaultId: 0,
    cancelId: 1,
  })
  if (response !== 0) return
  if (command) clipboard.writeText(command)
  else shell.openExternal(file?.url ?? INSTALL_HELP_URL)
}
