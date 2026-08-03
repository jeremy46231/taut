#!/usr/bin/env bun

// Builds and packages the Taut desktop app with electron-builder

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  Arch,
  type Configuration,
  build as electronBuild,
  Platform,
} from 'electron-builder'

if (!('Bun' in globalThis)) {
  console.error('This script must be run with Bun.')
  process.exit(1)
}

const ELECTRON_VERSION = '42.2.0'

const ROOT = path.join(import.meta.dir, '..')
const DESKTOP = path.join(ROOT, 'desktop')
const SRC = path.join(DESKTOP, 'src')
const DIST = path.join(ROOT, 'dist')
const OUT = path.join(DIST, 'desktop')
const BUILD_ROOT = path.join(DESKTOP, 'build')
const STAGE = path.join(BUILD_ROOT, 'app')
const ICON = path.join(ROOT, 'assets', 'logo.png')
const MAC_ICON = path.join(ROOT, 'assets', 'logo-macos.png')

/** Version of the taut.js app bundle (root package.json) */
const TAUT_VERSION: string = JSON.parse(
  await readFile(path.join(ROOT, 'package.json'), 'utf8')
).version
/** Version of the Electron desktop loader (desktop/package.json) */
const DESKTOP_VERSION: string = JSON.parse(
  await readFile(path.join(DESKTOP, 'package.json'), 'utf8')
).version

const MAC_SIGN_IDENTITY = 'Taut Code Signing'

function resolveMacIdentity(): string | null | undefined {
  if (process.env.CSC_LINK || process.env.CSC_NAME) return undefined
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync(
      'security',
      ['find-identity', '-v', '-p', 'codesigning'],
      { encoding: 'utf8' }
    )
    if (out.includes(MAC_SIGN_IDENTITY)) return MAC_SIGN_IDENTITY
  } catch {
    // `security` unavailable or no identities; fall through to skip signing
  }
  return null
}

const MAC_IDENTITY = resolveMacIdentity()

type Variant = 'standard' | 'embedded'
type PlatformKey = 'mac' | 'mac-x64' | 'win' | 'win-arm' | 'linux' | 'linux-arm'

const NODE_EXTERNALS = [
  'electron',
  'fs',
  'path',
  'os',
  'url',
  'module',
  'child_process',
  'crypto',
  'events',
  'stream',
  'util',
]

const INSTALLER_EXT = /\.(dmg|exe|msi|appimage|deb|rpm|snap)$/i

interface PlatformDef {
  platform: Platform
  os: 'mac' | 'win' | 'linux'
  targets: string[]
  archs: Arch[]
  nameArch: string
}

const PLATFORMS: Record<PlatformKey, PlatformDef> = {
  mac: {
    platform: Platform.MAC,
    os: 'mac',
    targets: ['dmg'],
    archs: [Arch.arm64],
    nameArch: '',
  },
  'mac-x64': {
    platform: Platform.MAC,
    os: 'mac',
    targets: ['dmg'],
    archs: [Arch.x64],
    nameArch: '-x64',
  },
  win: {
    platform: Platform.WINDOWS,
    os: 'win',
    targets: ['nsis'],
    archs: [Arch.x64],
    nameArch: '',
  },
  'win-arm': {
    platform: Platform.WINDOWS,
    os: 'win',
    targets: ['nsis'],
    archs: [Arch.arm64],
    nameArch: '-arm',
  },
  linux: {
    platform: Platform.LINUX,
    os: 'linux',
    targets: ['AppImage'],
    archs: [Arch.x64],
    nameArch: '',
  },
  'linux-arm': {
    platform: Platform.LINUX,
    os: 'linux',
    targets: ['AppImage'],
    archs: [Arch.arm64],
    nameArch: '-arm',
  },
}

const PLATFORM_KEYS = Object.keys(PLATFORMS) as PlatformKey[]
const VARIANT_KEYS: Variant[] = ['standard', 'embedded']

// Selectors

function getCombos(): Array<{ platform: PlatformKey; variant: Variant }> {
  const args = process.argv.slice(2)
  const platforms = new Set<PlatformKey>()
  const variants = new Set<Variant>()

  for (const arg of args) {
    if (arg === 'all') {
      for (const p of PLATFORM_KEYS) platforms.add(p)
    } else if ((PLATFORM_KEYS as string[]).includes(arg)) {
      platforms.add(arg as PlatformKey)
    } else if ((VARIANT_KEYS as string[]).includes(arg)) {
      variants.add(arg as Variant)
    } else {
      console.error(
        `[build-desktop] Unknown name "${arg}". Valid platforms: ${PLATFORM_KEYS.join(', ')}, all. Valid variants: ${VARIANT_KEYS.join(', ')}`
      )
      process.exit(1)
    }
  }

  if (platforms.size === 0) {
    console.error(
      `[build-desktop] Specify at least one platform to build. Valid: ${PLATFORM_KEYS.join(', ')}, all`
    )
    process.exit(1)
  }
  if (variants.size === 0) variants.add('standard')

  return [...variants].flatMap((variant) =>
    [...platforms].map((platform) => ({ variant, platform }))
  )
}

// Stage the variant's compiled JS into desktop/build/app/

async function buildJs(variant: Variant) {
  const define = {
    __TAUT_EMBEDDED__: String(variant === 'embedded'),
    __TAUT_LOADER_VERSION__: JSON.stringify(DESKTOP_VERSION),
  }
  const isEmbedded = variant === 'embedded'

  await rm(STAGE, { recursive: true, force: true })
  await mkdir(STAGE, { recursive: true })

  const builds: Array<{
    label: string
    opts: Parameters<typeof Bun.build>[0]
  }> = [
    {
      label: 'preload',
      opts: {
        entrypoints: [path.join(SRC, 'preload.ts')],
        outdir: STAGE,
        target: 'node',
        format: 'cjs',
        define,
        external: NODE_EXTERNALS,
        naming: 'preload.js',
      },
    },
    {
      label: 'options preload',
      opts: {
        entrypoints: [path.join(SRC, 'options', 'preload.cjs')],
        outdir: STAGE,
        target: 'node',
        format: 'cjs',
        define,
        external: ['electron'],
        naming: 'options-preload.js',
      },
    },
    {
      label: 'main',
      opts: {
        entrypoints: [path.join(SRC, 'main.ts')],
        outdir: STAGE,
        target: 'node',
        format: 'esm',
        define,
        external: ['electron'],
        naming: 'main.js',
      },
    },
  ]

  await Promise.all(
    builds.map(async ({ label, opts }) => {
      const result = await Bun.build(opts)
      if (!result.success) {
        console.error(`[build-desktop] ${label} build failed:`, result.logs)
        process.exit(1)
      }
    })
  )

  const substituteOptions = (src: string) =>
    src
      .replace(/__TAUT_EMBEDDED__/g, String(isEmbedded))
      .replace(/__TAUT_RUNTIME__/g, "'electron'")
      .replace(
        /__TAUT_EMBEDDED_VERSION__/g,
        isEmbedded ? `'${TAUT_VERSION}'` : "''"
      )

  await writeFile(
    path.join(STAGE, 'options.html'),
    substituteOptions(
      await readFile(path.join(ROOT, 'shared', 'options.html'), 'utf8')
    ),
    'utf8'
  )
  await writeFile(
    path.join(STAGE, 'options.js'),
    substituteOptions(
      await readFile(path.join(ROOT, 'shared', 'options.js'), 'utf8')
    ),
    'utf8'
  )

  await cp(ICON, path.join(STAGE, 'icon.png'))
}

// electron-builder config per (variant, platform)

function makeConfig(variant: Variant, pk: PlatformKey): Configuration {
  const isEmbedded = variant === 'embedded'
  const suffix = isEmbedded ? '-embedded' : ''
  const def = PLATFORMS[pk]
  const artifactName = `taut-${def.os}${def.nameArch}${suffix}.\${ext}`

  return {
    appId: 'app.jer.taut',
    productName: 'Taut',
    electronVersion: ELECTRON_VERSION,
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    directories: { output: path.join(BUILD_ROOT, 'builder', variant) },
    files: [
      'package.json',
      { from: 'build/app', to: 'build/app', filter: ['**/*'] },
    ],
    extraMetadata: {
      name: `taut${suffix}`,
      main: 'build/app/main.js',
      ...(isEmbedded
        ? {
            description: `Client mod for Slack (with embedded app v${TAUT_VERSION})`,
            version: `${DESKTOP_VERSION}-embedded-${TAUT_VERSION}`,
          }
        : {}),
    },
    extraResources: isEmbedded
      ? [{ from: path.join(DIST, 'taut.debug.js'), to: 'taut.js' }]
      : [],
    protocols: [{ name: 'Slack URL', schemes: ['slack'], role: 'Viewer' }],
    artifactName,
    mac: {
      icon: MAC_ICON,
      category: 'public.app-category.productivity',
      identity: MAC_IDENTITY,
      hardenedRuntime: false,
      gatekeeperAssess: false,
    },
    win: { icon: ICON },
    linux: {
      icon: ICON,
      category: 'Utility',
      mimeTypes: ['x-scheme-handler/slack'],
    },
  }
}

// Package one variant for the given platforms, move installers to dist/

async function packageVariant(variant: Variant, platforms: PlatformKey[]) {
  if (variant === 'embedded' && !existsSync(path.join(DIST, 'taut.debug.js'))) {
    console.error(
      '[build-desktop] Missing dist/taut.debug.js, run `bun build:taut` first.'
    )
    process.exit(1)
  }

  console.log(
    `[build-desktop] Building ${variant} [${platforms.join(', ')}]...`
  )
  await buildJs(variant)

  await rm(path.join(BUILD_ROOT, 'builder', variant), {
    recursive: true,
    force: true,
  })
  await mkdir(OUT, { recursive: true })

  for (const pk of platforms) {
    const def = PLATFORMS[pk]
    if (def.os === 'mac') {
      const how =
        MAC_IDENTITY === undefined
          ? 'cert from CSC_LINK/CSC_NAME'
          : MAC_IDENTITY
            ? `identity "${MAC_IDENTITY}"`
            : 'UNSIGNED (no cert found; notifications and stuff will not register)'
      console.log(`[build-desktop] macOS signing: ${how}`)
    }
    const artifacts = await electronBuild({
      projectDir: DESKTOP,
      targets: def.platform.createTarget(def.targets, ...def.archs),
      publish: 'never',
      config: makeConfig(variant, pk),
    })

    for (const artifact of artifacts) {
      const name = path.basename(artifact)
      if (!INSTALLER_EXT.test(name)) continue
      await rename(artifact, path.join(OUT, name))
      console.log(`[build-desktop] - dist/desktop/${name}`)
    }
  }
}

// Run

const combos = getCombos()

const byVariant = new Map<Variant, Set<PlatformKey>>()
for (const { platform, variant } of combos) {
  if (!byVariant.has(variant)) byVariant.set(variant, new Set())
  byVariant.get(variant)?.add(platform)
}

try {
  for (const [variant, platforms] of byVariant) {
    await packageVariant(variant, [...platforms])
  }
  console.log('[build-desktop] Done.')
} finally {
  await rm(BUILD_ROOT, { recursive: true, force: true })
}
