#!/usr/bin/env node

// Reports what this desktop leg published to taut.jer.app (server/src/desktop.ts), usage in CI: node scripts/reportDesktop.ts desktop-v<version>

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  DESKTOP_UPDATE_CHANNELS,
  type DesktopFormat,
  type DesktopReleaseRecord,
} from '../shared/updates.ts'
import { DESKTOP_PLATFORMS, PLATFORM_KEYS } from './lib/artifacts.ts'
import { DIST } from './lib/paths.ts'
import { TAUT_SERVER } from './lib/releases.ts'
import { rewriteFeed } from './lib/updateFeed.ts'

const TARGET_FORMAT: Record<string, DesktopFormat> = {
  dmg: 'dmg',
  nsis: 'exe',
  AppImage: 'AppImage',
  deb: 'deb',
  rpm: 'rpm',
  pacman: 'pacman',
}

const tag = process.argv[2]
if (!tag?.startsWith('desktop-v')) {
  console.error('usage: node scripts/reportDesktop.ts desktop-v<version>')
  process.exit(1)
}
const repo = process.env.GITHUB_REPOSITORY || 'jeremy46231/taut'
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(
      `[report] ${url}: HTTP ${response.status} ${await response.text()}`
    )
  }
  return response
}

interface ReleaseAsset {
  name: string
  state: string
  size: number
  browser_download_url: string
  digest?: string | null
}
const release = (await (
  await fetchOk(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
).json()) as { assets: ReleaseAsset[] }
const published = new Map(
  release.assets.filter((a) => a.state === 'uploaded').map((a) => [a.name, a])
)

// this leg's files that are uploaded to the release
const names: string[] = []
for (const dir of ['desktop', 'repo']) {
  if (existsSync(path.join(DIST, dir)))
    names.push(...(await readdir(path.join(DIST, dir))))
}
const assets: DesktopReleaseRecord['assets'] = {}
for (const name of names) {
  const asset = published.get(name)
  if (!asset) continue
  const sha256 = asset.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1]
  if (!sha256) throw new Error(`[report] ${tag}/${name} has no sha256 digest`)
  assets[name] = { url: asset.browser_download_url, sha256, size: asset.size }
}

const urls = new Map(
  [...published].map(([name, a]) => [name, a.browser_download_url])
)
const platforms: DesktopReleaseRecord['platforms'] = {}
const feeds: DesktopReleaseRecord['feeds'] = {}
for (const key of PLATFORM_KEYS) {
  const { targets } = DESKTOP_PLATFORMS[key]
  const files: DesktopReleaseRecord['platforms'][typeof key] = {}
  for (const format of targets.map((t) => TARGET_FORMAT[t])) {
    const asset = assets[`taut-${key}.${format}`]
    if (asset) files[format] = { url: asset.url }
  }
  if (Object.keys(files).length < targets.length) continue
  platforms[key] = files

  const { file } = DESKTOP_UPDATE_CHANNELS[key]
  if (!assets[file]) continue
  const yml = await (await fetchOk(assets[file].url)).text()
  const rewritten = rewriteFeed(yml, urls)
  if (rewritten) feeds[file] = rewritten
  else console.warn(`[report] ${file} names a file ${tag} doesn't have`)
}

const {
  ACTIONS_ID_TOKEN_REQUEST_URL: tokenUrl,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN,
} = process.env
if (!tokenUrl || !ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
  throw new Error('[report] needs a GitHub Actions job with id-token: write')
}
const { value: oidc } = (await (
  await fetchOk(`${tokenUrl}&audience=${encodeURIComponent(TAUT_SERVER)}`, {
    headers: { authorization: `Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  })
).json()) as { value: string }

const report: DesktopReleaseRecord = {
  version: tag.slice('desktop-v'.length),
  assets,
  platforms,
  feeds,
}
await fetchOk(`${TAUT_SERVER}/api/desktop-releases`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${oidc}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(report),
})
console.log(
  `[report] ${tag}: ${Object.keys(assets).length} files, platforms ${Object.keys(platforms).join(' ') || 'none'}, feeds ${Object.keys(feeds).join(' ') || 'none'}`
)
