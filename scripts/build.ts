#!/usr/bin/env node

// Builds Taut, run with --help for usage

import {
  hostPlatformKey,
  PLATFORM_KEYS,
  type PlatformKey,
  type Variant,
} from './lib/artifacts.ts'

try {
  process.loadEnvFile()
} catch {}

const TARGETS = [
  'taut',
  'extension',
  'userscript',
  'desktop',
  'versions',
  'server',
] as const
type Target = (typeof TARGETS)[number]

const USAGE = `usage: npm run build -- [targets...] [platforms...] [--standard] [--embedded]
       (or bun run build ...)

targets    ${TARGETS.join(' ')}
           default: taut extension userscript
platforms  ${PLATFORM_KEYS.join(' ')} all
           desktop only, default: this machine
variants   --standard (default), --embedded, or both for both
           --embedded always rebuilds taut first

examples
  npm run build                             bundle, extensions and userscript
  npm run build -- extension --embedded     embedded extensions only
  npm run build -- desktop                  desktop app for this machine
  npm run build -- desktop mac win-arm --standard --embedded
  npm run build -- versions server          stage the Worker's assets from dist/
`

function fail(message: string): never {
  console.error(`[build] ${message}\n\n${USAGE}`)
  process.exit(1)
}

const targets = new Set<Target>()
const platforms = new Set<PlatformKey>()
const variants = new Set<Variant>()

for (const arg of process.argv.slice(2)) {
  if (arg === '-h' || arg === '--help') {
    console.log(USAGE)
    process.exit(0)
  } else if (arg === '--standard') variants.add('standard')
  else if (arg === '--embedded') variants.add('embedded')
  else if ((TARGETS as readonly string[]).includes(arg))
    targets.add(arg as Target)
  else if ((PLATFORM_KEYS as string[]).includes(arg))
    platforms.add(arg as PlatformKey)
  else if (arg === 'all') for (const p of PLATFORM_KEYS) platforms.add(p)
  else fail(`Unknown argument "${arg}"`)
}

if (targets.size === 0) {
  for (const t of ['taut', 'extension', 'userscript'] as const) targets.add(t)
}
if (variants.size === 0) variants.add('standard')
if (platforms.size > 0 && !targets.has('desktop')) {
  fail('Platforms only apply to the desktop target')
}
if (targets.has('desktop') && platforms.size === 0) {
  platforms.add(hostPlatformKey())
}

// embedded loaders carry a copy of the bundle, so build it first
if (variants.has('embedded')) targets.add('taut')

const variantList = [...variants]

if (targets.has('taut')) {
  const { buildTaut } = await import('./build/taut.ts')
  await buildTaut()
}
if (targets.has('extension')) {
  const { buildExtension } = await import('./build/extension.ts')
  await buildExtension(variantList)
}
if (targets.has('userscript')) {
  const { buildUserscript } = await import('./build/userscript.ts')
  await buildUserscript(variantList)
}
if (targets.has('desktop')) {
  const { buildDesktop } = await import('./build/desktop.ts')
  await buildDesktop([...platforms], variantList)
}

if (targets.has('versions')) {
  const { buildVersions } = await import('./build/versions.ts')
  await buildVersions()
}
if (targets.has('server')) {
  const { buildServer } = await import('./build/server.ts')
  await buildServer()
}

console.log('[build] Done!')
