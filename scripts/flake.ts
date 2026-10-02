#!/usr/bin/env node

// usage: node scripts/flake.ts [flake.nix], CI runs it after each release

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ROOT } from './lib/paths.ts'
import { desktopReleases, newestWith } from './lib/releases.ts'

const SYSTEM_FILES = {
  'x86_64-linux': 'taut-linux.AppImage',
  'aarch64-linux': 'taut-linux-arm.AppImage',
  'x86_64-darwin': 'taut-mac-x64.dmg',
  'aarch64-darwin': 'taut-mac.dmg',
}

const file = path.resolve(process.argv[2] ?? path.join(ROOT, 'flake.nix'))
const flake = await readFile(file, 'utf8')
const start = flake.indexOf('# begin releases')
const end = flake.indexOf('# end releases')
if (start === -1 || end < start) {
  throw new Error(
    `[flake] ${file} has no "# begin releases" ... "# end releases" block`
  )
}
const lineStart = flake.lastIndexOf('\n', start) + 1
const indent = flake.slice(lineStart, start)

// default to keeping the current pins
const pinned = new Map(
  [
    ...flake
      .slice(start, end)
      .matchAll(
        /([\w-]+) = \{\s*version = "([^"]*)";\s*file = "([^"]*)";\s*hash = "([^"]*)";/g
      ),
  ].map(([, system, version, file, hash]) => [system, { version, file, hash }])
)

const releases = await desktopReleases()
const lines = ['# begin releases (written by scripts/flake.ts)', 'releases = {']
for (const [system, name] of Object.entries(SYSTEM_FILES)) {
  const found = newestWith(releases, name)
  const pin = found
    ? {
        version: found.release.version,
        file: name,
        hash: `sha256-${Buffer.from(found.asset.sha256, 'hex').toString('base64')}`,
      }
    : pinned.get(system)
  if (!found) console.warn(`[flake] ${system}: no published ${name}`)
  if (!pin) continue
  lines.push(
    `  ${system} = {`,
    `    version = "${pin.version}";`,
    `    file = "${pin.file}";`,
    `    hash = "${pin.hash}";`,
    '  };'
  )
  console.log(`[flake] ${system}: ${pin.version} ${pin.hash}`)
}
lines.push('};')

const block = lines.map((l, i) => (i === 0 ? l : indent + l)).join('\n')
const next = `${flake.slice(0, start)}${block}\n${indent}${flake.slice(end)}`
if (next === flake) {
  console.log('[flake] already up to date')
} else {
  await writeFile(file, next)
  console.log(`[flake] updated ${path.relative(process.cwd(), file)}`)
}
