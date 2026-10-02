// builds taut-versions.json minus the desktop releases, which the Worker adds from its ledger (server/src/desktop.ts)

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { compareVersions, type VersionsFile } from '../../shared/updates.ts'
import { DIST, SERVER_VERSIONS, TAUT_JS } from '../lib/paths.ts'
import { recommended, versions } from '../lib/versions.ts'

/** the version inside the file being served, which CI downloads from the `latest` release, so a failed upload isn't advertised */
function servedVersion(
  file: string,
  read: (file: string) => string | undefined,
  checkout: string
): string {
  if (!existsSync(file)) return checkout
  const version = read(file)
  if (version) return version
  console.warn(
    `[build-versions] dist/${path.relative(DIST, file)} has no version, using the checkout's ${checkout}`
  )
  return checkout
}

const text = (file: string) => readFileSync(file, 'utf8')

// the banner from scripts/build/taut.ts
const bannerVersion = (file: string) =>
  text(file)
    .slice(0, 100)
    .match(/^\/\/ Taut v(\S+)/)?.[1]

const userscriptVersion = (file: string) =>
  text(file).match(/^\/\/ @version\s+(\S+)/m)?.[1]

function zipManifestVersion(file: string): string | undefined {
  const { 'manifest.json': manifest } = unzipSync(readFileSync(file), {
    filter: (entry) => entry.name === 'manifest.json',
  })
  return manifest && JSON.parse(strFromU8(manifest)).version
}

// what AMO actually signed, which lags the manifest when signing is skipped
function firefoxUpdatesVersion(file: string): string | undefined {
  const addon = Object.values(JSON.parse(text(file)).addons ?? {})[0] as
    | { updates?: { version?: string }[] }
    | undefined
  return addon?.updates?.[0]?.version
}

export async function buildVersions() {
  const file: VersionsFile = {
    schema: 1,
    app: { version: servedVersion(TAUT_JS, bannerVersion, versions.taut) },
    loaders: {
      'chrome-extension': {
        latest: servedVersion(
          path.join(DIST, 'extension', 'taut-chrome.zip'),
          zipManifestVersion,
          versions.chromeExtension
        ),
        recommended: recommended.chromeExtension,
        url: 'https://taut.jer.app/taut-chrome.zip',
      },
      'firefox-extension': {
        latest: servedVersion(
          path.join(DIST, 'extension', 'signed', 'taut-firefox-updates.json'),
          firefoxUpdatesVersion,
          versions.firefoxExtension
        ),
        recommended: recommended.firefoxExtension,
        url: 'https://taut.jer.app/taut-firefox.xpi',
      },
      userscript: {
        latest: servedVersion(
          path.join(DIST, 'userscript', 'taut.user.js'),
          userscriptVersion,
          versions.userscript
        ),
        recommended: recommended.userscript,
        url: 'https://taut.jer.app/taut.user.js',
      },
      electron: {
        latest: null,
        recommended: recommended.desktop,
        platforms: {},
      },
    },
  }

  for (const [name, loader] of Object.entries(file.loaders)) {
    if (
      loader.latest &&
      compareVersions(loader.recommended, loader.latest) > 0
    ) {
      console.warn(
        `[build-versions] ${name}: recommended ${loader.recommended} is above latest ${loader.latest}, clients treat it as ${loader.latest}`
      )
    }
  }

  await mkdir(DIST, { recursive: true })
  await writeFile(SERVER_VERSIONS, JSON.stringify(file))
  console.log(
    `[build-versions] dist/${path.basename(SERVER_VERSIONS)} (app ${file.app.version})`
  )
}
