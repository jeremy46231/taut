import type {
  BlobStore,
  TautDesktopPlatform,
  TautInstall,
} from '../shared/TautBridge'
import {
  compareVersions,
  INSTALL_HELP_URL,
  type LoaderName,
  updateCommand,
  VERSIONS_URL,
  type VersionsFile,
} from '../shared/updates'
import type { NormalizedBridge } from './bridgeCompat'
import { tautVersion } from './bundledData'
import { Store } from './store'

export interface UpdateAction {
  label: string
  run?: () => void
  href?: string
  /** set when `label` is a shell command, which `run` copies */
  command?: boolean
}

export interface UpdateItem {
  /** what's outdated, e.g. "Taut" or "Taut desktop app" */
  what: string
  current: string
  latest: string
  /** worth a notice (red dot), otherwise only the Advanced screen shows it */
  notify: boolean
  action: UpdateAction
}

/** null while everything is up to date, or unknown */
export type UpdateStatus = { items: UpdateItem[] } | null

export const updateStatus = new Store<UpdateStatus>(null)

export const noticeItems = (status: UpdateStatus): UpdateItem[] =>
  status?.items.filter((item) => item.notify) ?? []

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const FETCH_INTERVAL = 6 * HOUR
/** how long a loader that updates itself gets before the notice shows */
const SELF_UPDATE_GRACE = 3 * DAY

export interface StatusInput {
  app: string
  loader: LoaderName
  loaderVersion: string
  install: TautInstall | null
  /** the desktop installer that fits this machine, when known */
  platform: TautDesktopPlatform | null
  versions: VersionsFile
  now: number
  /** when the loader was first seen below the current recommended version */
  belowSince: number | null
  reload: () => void
  /** restarts into the update the loader has downloaded */
  restart: (() => void) | null
  /** the version of that downloaded update, if there is one */
  ready: string | null
}

function loaderTarget({ loader, versions, platform, ready }: StatusInput) {
  if (loader === 'electron') {
    const desktop = versions.loaders.electron
    // only what is published for this machine
    const listed = platform
      ? desktop.platforms[platform]?.version
      : desktop.latest
    // a downloaded update counts before taut-versions.json lists it
    const latest =
      ready && (!listed || compareVersions(ready, listed) > 0) ? ready : listed
    return latest ? { latest, recommended: desktop.recommended } : null
  }
  return versions.loaders[loader] ?? null
}

export function updatesItself({
  loader,
  loaderVersion,
  install,
}: Pick<StatusInput, 'loader' | 'loaderVersion' | 'install'>): boolean {
  if (loader === 'userscript') return true
  if (loader === 'electron') return !!install?.canSelfUpdate
  if (loader === 'firefox-extension') {
    return compareVersions(loaderVersion, '1.5.0') >= 0
  }
  return false
}

function loaderAction(input: StatusInput): UpdateAction {
  const { loader, install, versions } = input
  const command = updateCommand(install?.type ?? null)
  if (command) {
    return {
      label: command,
      command: true,
      run: () => navigator.clipboard.writeText(command),
    }
  }
  const href =
    loader === 'firefox-extension' || loader === 'userscript'
      ? versions.loaders[loader].url
      : INSTALL_HELP_URL
  return { label: 'How to update', href }
}

export function computeStatus(input: StatusInput): UpdateStatus {
  if (input.versions?.schema !== 1) return null
  const items: UpdateItem[] = []

  const app = input.versions.app?.version
  if (app && compareVersions(input.app, app) < 0) {
    items.push({
      what: 'Taut',
      current: input.app,
      latest: app,
      notify: true,
      action: { label: 'Reload', run: input.reload },
    })
  }

  const target = loaderTarget(input)
  if (target && compareVersions(input.loaderVersion, target.latest) < 0) {
    const recommended =
      compareVersions(target.recommended, target.latest) > 0
        ? target.latest
        : target.recommended
    const below = compareVersions(input.loaderVersion, recommended) < 0
    const inGrace =
      updatesItself(input) &&
      (input.belowSince === null ||
        input.now - input.belowSince < SELF_UPDATE_GRACE)
    const { install, restart, ready } = input
    // a downloaded update is one click away
    const downloaded = install?.canSelfUpdate && restart && ready
    items.push({
      what: {
        electron: 'Taut desktop app',
        'chrome-extension': 'Taut extension',
        'firefox-extension': 'Taut extension',
        userscript: 'Taut userscript',
      }[input.loader],
      current: input.loaderVersion,
      latest: target.latest,
      notify: !!downloaded || (below && !inGrace),
      action: downloaded
        ? { label: 'Restart', run: restart }
        : loaderAction(input),
    })
  }

  return items.length > 0 ? { items } : null
}

interface NavigatorUAData {
  platform: string
  getHighEntropyValues(hints: string[]): Promise<{ architecture?: string }>
}

/** which desktop installer fits this machine, for loaders that can't say */
export async function detectPlatform(): Promise<TautDesktopPlatform | null> {
  const uaData = (navigator as { userAgentData?: NavigatorUAData })
    .userAgentData
  const os = uaData?.platform || navigator.platform
  let arch: string | undefined
  try {
    arch = (await uaData?.getHighEntropyValues(['architecture']))?.architecture
  } catch {}
  if (/mac/i.test(os)) return arch === 'x86' ? 'mac-x64' : 'mac'
  if (/win/i.test(os)) return arch === 'arm' ? 'win-arm' : 'win'
  if (/linux/i.test(os)) return arch === 'arm' ? 'linux-arm' : 'linux'
  return null
}

async function readJson<T>(blob: BlobStore, key: string): Promise<T | null> {
  try {
    const raw = await blob.read(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

async function loadVersions(blob: BlobStore): Promise<VersionsFile | null> {
  const cached = await readJson<{ fetchedAt: number; versions: VersionsFile }>(
    blob,
    'versions'
  )
  if (cached && Date.now() - cached.fetchedAt < FETCH_INTERVAL) {
    return cached.versions
  }
  try {
    const response = await fetch(VERSIONS_URL, { cache: 'no-cache' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const versions = (await response.json()) as VersionsFile
    await blob.write(
      'versions',
      JSON.stringify({ fetchedAt: Date.now(), versions })
    )
    return versions
  } catch (err) {
    console.warn('[Taut] Update check failed:', err)
    return cached?.versions ?? null
  }
}

let started = false

export function startUpdateCheck(bridge: NormalizedBridge) {
  if (started || bridge.embedded || bridge.install?.type === 'embedded') return
  started = true
  const blob = bridge.blobStore('update_check')
  const install = bridge.install ?? null
  const platform =
    bridge.loader !== 'electron'
      ? Promise.resolve(null)
      : install
        ? Promise.resolve(install.platform)
        : detectPlatform()

  // the desktop app downloads its own updates, then offers a restart
  let ready: string | null = null
  const check = async () => {
    const versions = await loadVersions(blob)
    if (!versions) return
    const input: StatusInput = {
      app: tautVersion,
      loader: bridge.loader,
      loaderVersion: bridge.loaderVersion,
      install,
      platform: await platform,
      versions,
      now: Date.now(),
      belowSince: null,
      reload: () => location.reload(),
      restart: bridge.restartToUpdate ?? null,
      ready,
    }
    // a self-updating loader's grace period starts when this recommended version is first seen
    const recommended = loaderTarget(input)?.recommended
    if (
      recommended &&
      updatesItself(input) &&
      compareVersions(input.loaderVersion, recommended) < 0
    ) {
      const seen = await readJson<Record<string, number>>(blob, 'seen')
      input.belowSince = seen?.[recommended] ?? input.now
      if (!seen?.[recommended]) {
        await blob.write('seen', JSON.stringify({ [recommended]: input.now }))
      }
    }
    updateStatus.set(computeStatus(input))
  }

  check()
  setInterval(() => check(), HOUR)
  bridge.onUpdateReady?.((version) => {
    ready = version
    check()
  })
}
