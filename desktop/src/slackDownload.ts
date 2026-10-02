// Taut Desktop Slack downloader

import {
  createWriteStream,
  existsSync,
  readFileSync,
  renameSync,
} from 'node:fs'
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'
import { BrowserWindow, dialog, net } from 'electron'
import tar from 'tar-stream'
import { compareVersions } from '../../shared/updates'
import { installerArch } from './installType.js'
import {
  type Arch,
  downloadedNativesDir,
  slackNativeArches,
} from './nativeModules.js'
import { configDir } from './paths.js'
import { extractDebDir, extractZipDir } from './slackArchive.js'

declare const __TAUT_SLACK_VERSION__: string
export const SLACK_VERSION = __TAUT_SLACK_VERSION__

const CDN = 'https://downloads.slack-edge.com/desktop-releases'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** the Slack build a Taut of `arch` runs, arm64 linux runs the x64 deb with arm64 natives swapped in */
export const slackArch = (arch: string = process.arch): Arch =>
  arch === 'arm64' && process.platform !== 'linux' ? 'arm64' : 'x64'

const slackRoot = () => path.join(configDir(), 'slack')
const cacheName = (version: string, arch: string) =>
  `${version}-${slackArch(arch)}`

/** @param arch of the Taut that will load it */
export function cachedSlackAsar(
  version = SLACK_VERSION,
  arch: string = process.arch
): string | undefined {
  const asar = path.join(slackRoot(), cacheName(version, arch), 'app.asar')
  if (!existsSync(asar)) adoptUnsuffixedCache(version)
  return existsSync(asar) ? asar : undefined
}

// caches were named by version alone until the arch was added, remove once those are gone
function adoptUnsuffixedCache(version: string) {
  const dir = path.join(slackRoot(), version)
  if (!existsSync(path.join(dir, 'app.asar'))) return
  const arches = slackNativeArches(dir)
  if (!arches || arches.size === 0) return
  const arch = arches.has(slackArch()) ? slackArch() : [...arches][0]
  try {
    renameSync(dir, path.join(slackRoot(), `${version}-${arch}`))
    console.log(`[Taut] Slack cache ${version} is ${arch}`)
  } catch (err) {
    console.warn(`[Taut] Couldn't rename Slack cache ${version}:`, err)
  }
}

function release(
  v: string,
  arch: Arch
): {
  url: string
  resources: string
  kind: 'zip' | 'deb'
} {
  switch (process.platform) {
    case 'darwin':
      return {
        url: `${CDN}/mac/${arch}/${v}/Slack-${v}-macOS.zip`,
        resources: 'Slack.app/Contents/Resources',
        kind: 'zip',
      }
    case 'win32':
      return {
        url: `${CDN}/windows/${arch}/${v}/Slack.msix`,
        resources: 'app/resources',
        kind: 'zip',
      }
    default:
      return {
        url: `${CDN}/linux/x64/${v}/slack-desktop-${v}-amd64.deb`,
        resources: './usr/lib/slack/resources',
        kind: 'deb',
      }
  }
}

export type Progress =
  | { phase: 'download'; received: number; total: number }
  | { phase: 'unpack' }

async function download(
  url: string,
  dest: string,
  onProgress: (p: Progress) => void
) {
  const res = await net.fetch(url)
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  let received = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      onProgress({ phase: 'download', received, total })
      callback(null, chunk)
    },
  })
  await pipeline(
    Readable.fromWeb(res.body as ReadableStream),
    counter,
    createWriteStream(dest)
  )
}

const downloads = new Map<string, Promise<void>>()

/** needs the app to be ready (uses net), `arch` is of the Taut that will load it */
export function downloadSlack(
  onProgress: (p: Progress) => void = () => {},
  version = SLACK_VERSION,
  arch: string = process.arch
): Promise<void> {
  const name = cacheName(version, arch)
  let running = downloads.get(name)
  if (!running) {
    running = fetchSlack(name, version, arch, onProgress).finally(() =>
      downloads.delete(name)
    )
    downloads.set(name, running)
  }
  return running
}

async function fetchSlack(
  name: string,
  version: string,
  arch: string,
  onProgress: (p: Progress) => void
) {
  if (cachedSlackAsar(version, arch)) return
  const { url, resources, kind } = release(version, slackArch(arch))
  const root = slackRoot()
  const archive = path.join(root, `${name}.download`)
  const work = path.join(root, `${name}.partial`)
  await mkdir(root, { recursive: true })
  await rm(work, { recursive: true, force: true })

  console.log(`[Taut] Downloading Slack ${version} from ${url}`)
  await download(url, archive, onProgress)
  onProgress({ phase: 'unpack' })
  await (kind === 'deb' ? extractDebDir : extractZipDir)(
    archive,
    resources,
    work
  )
  if (!existsSync(path.join(work, 'app.asar'))) {
    throw new Error(`${url} did not contain ${resources}/app.asar`)
  }
  await downloadSlackNatives(work, arch).catch((err) =>
    console.warn('[Taut] arm64 slack-desktop-utils download failed:', err)
  )
  await rename(work, path.join(root, name))
  await rm(work, { recursive: true, force: true })
  await rm(archive, { force: true })
  await pruneSlackCache(name)
  console.log(`[Taut] Slack ${name} ready`)
}

// newer cached Slacks stay, they were fetched for an update not installed yet, in the arch it will run
export async function pruneSlackCache(keep?: string) {
  const root = slackRoot()
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return
  }
  const arches = new Set([slackArch(), slackArch(installerArch())])
  for (const entry of entries) {
    const match =
      /^(\d+(?:\.\d+)*)(?:-(x64|arm64))?(\.partial|\.download)?$/.exec(entry)
    if (!match || entry === keep) continue
    const [, version, arch, unfinished] = match
    const age = compareVersions(version, SLACK_VERSION)
    // an unsuffixed cache that still fit was adopted when it was looked up
    const stale = arch
      ? age < 0 || !arches.has(arch as Arch)
      : age <= 0 || !!unfinished
    if (stale)
      await rm(path.join(root, entry), { recursive: true, force: true })
  }
}

// Slack publishes linux arm64 N-API prebuilds of its proprietary module at the node-pre-gyp location in its package.json
function slackDesktopUtilsPrebuildUrl(slackResourcesPath: string): string {
  const pkg = JSON.parse(
    readFileSync(
      path.join(
        slackResourcesPath,
        'app.asar',
        'node_modules',
        '@tinyspeck',
        'slack-desktop-utils',
        'package.json'
      ),
      'utf8'
    )
  )
  const { binary, version } = pkg
  const fields: Record<string, string> = {
    module_name: binary.module_name,
    version,
    napi_build_version: String(Math.max(...binary.napi_versions)),
    platform: 'linux',
    arch: 'arm64',
  }
  const name = (binary.package_name as string).replace(
    /\{(\w+)\}/g,
    (_, key) => fields[key]
  )
  return `${binary.production_host}/${name}`
}

/** on arm64 linux, fetches the arm64 slack-desktop-utils next to the given Slack */
export async function downloadSlackNatives(
  slackResourcesPath: string,
  arch: string = process.arch
) {
  if (process.platform !== 'linux' || arch !== 'arm64') return
  const dir = downloadedNativesDir(slackResourcesPath)
  try {
    await access(path.join(dir, 'slackdesktoputils.node'))
    return
  } catch {}
  const url = slackDesktopUtilsPrebuildUrl(slackResourcesPath)
  console.log(`[Taut] Downloading arm64 slack-desktop-utils from ${url}`)
  const res = await net.fetch(url)
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`)
  await mkdir(dir, { recursive: true })
  const extract = tar.extract()
  extract.on('entry', (header, stream, next) => {
    if (header.type !== 'file' || !header.name.endsWith('.node')) {
      stream.resume()
      stream.on('end', next)
      return
    }
    pipeline(
      stream,
      createWriteStream(path.join(dir, path.basename(header.name)))
    ).then(
      () => next(),
      (err) => extract.destroy(err)
    )
  })
  await pipeline(
    Readable.fromWeb(res.body as ReadableStream),
    createGunzip(),
    extract
  )
  console.log(`[Taut] arm64 slack-desktop-utils ready in ${dir}`)
}

const mb = (bytes: number) => (bytes / 1e6).toFixed(0)

/** for first launch with no Slack on disk */
export async function downloadSlackWithWindow() {
  const win = new BrowserWindow({
    width: 380,
    height: 110,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Taut',
    icon: path.join(__dirname, 'icon.png'),
    show: false,
  })
  win.setMenu(null)
  win.once('ready-to-show', () => win.show())
  await win.loadFile(path.join(__dirname, 'download.html'))

  let lastUpdate = 0
  const update = (p: Progress) => {
    const now = Date.now()
    if (p.phase === 'download' && now - lastUpdate < 100) return
    lastUpdate = now
    const state =
      p.phase === 'download'
        ? {
            text: `Downloading Slack ${SLACK_VERSION} (${mb(p.received)} of ${mb(p.total)} MB)`,
            value: p.total ? p.received / p.total : null,
          }
        : { text: `Unpacking Slack ${SLACK_VERSION}`, value: null }
    win.webContents
      .executeJavaScript(`update(${JSON.stringify(state)})`)
      .catch(() => {})
  }

  try {
    await downloadSlack(update)
  } catch (err) {
    win.close()
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'Taut',
      message: 'Slack could not be downloaded',
      detail: `${String(err)}\n\nCheck your connection, or install the official Slack app, then open Taut again. If this doesn't fix itself, report it in #taut.`,
      buttons: ['Quit'],
    })
    process.exit(1)
  }
  win.close()
}
