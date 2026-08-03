#!/usr/bin/env bun

// Builds distributable extension packages from the sources in extension/

import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { zipSync } from 'fflate'

if (!('Bun' in globalThis)) {
  console.error('This script must be run with Bun.')
  process.exit(1)
}

const ROOT = path.join(import.meta.dir, '..')
const EXT_SRC = path.join(ROOT, 'extension')
const DIST = path.join(ROOT, 'dist')
const OUT_ROOT = path.join(DIST, 'extension')
const TAUT_JS = path.join(DIST, 'taut.debug.js') // embedded builds use the debug version
const BRIDGE_TEMPLATE = path.join(EXT_SRC, 'shared', 'bridge-setup.template.js')
const ICONS_DIR = path.join(ROOT, 'assets', 'icons')
const ICON_SIZES = [16, 32, 48, 128] as const

const TAUT_VERSION: string = (
  await Bun.file(path.join(ROOT, 'package.json')).json()
).version

const LOADER_NAMES: Record<string, string> = {
  chrome: 'chrome-extension',
  firefox: 'firefox-extension',
}

const BROWSERS = ['chrome', 'firefox'] as const
type Variant = 'standard' | 'embedded'
const VARIANTS: Variant[] = process.argv.includes('--standard-only')
  ? ['standard']
  : ['standard', 'embedded']

await rm(OUT_ROOT, { recursive: true, force: true })

const bridgeTemplate = await readFile(BRIDGE_TEMPLATE, 'utf8')

for (const browser of BROWSERS) {
  const srcDir = path.join(EXT_SRC, browser)
  const loaderName = LOADER_NAMES[browser]
  const loaderVersion: string = (
    await Bun.file(path.join(srcDir, 'manifest.json')).json()
  ).version

  // Generate bridge-setup.js for this browser
  const bridgeSetup = bridgeTemplate
    .replace(/__TAUT_LOADER__/g, loaderName)
    .replace(/__TAUT_LOADER_VERSION__/g, loaderVersion)

  for (const variant of VARIANTS) {
    const isEmbedded = variant === 'embedded'
    const suffix = isEmbedded ? '-embedded' : ''
    const outDir = path.join(OUT_ROOT, `${browser}${suffix}`)
    await mkdir(outDir, { recursive: true })

    const entries: Record<string, Uint8Array> = {}
    const enc = new TextEncoder()

    entries['bridge-setup.js'] = enc.encode(bridgeSetup)

    for (const size of ICON_SIZES) {
      entries[`icons/icon-${size}.png`] = new Uint8Array(
        await Bun.file(path.join(ICONS_DIR, `icon-${size}.png`)).arrayBuffer()
      )
    }

    const substituteOptions = (src: string) =>
      src
        .replace(/__TAUT_EMBEDDED__/g, String(isEmbedded))
        .replace(/__TAUT_RUNTIME__/g, `'${browser}'`)
        .replace(
          /__TAUT_EMBEDDED_VERSION__/g,
          isEmbedded ? `'${TAUT_VERSION}'` : "''"
        )

    entries['options.html'] = enc.encode(
      substituteOptions(
        await readFile(path.join(ROOT, 'shared', 'options.html'), 'utf8')
      )
    )
    entries['options.js'] = enc.encode(
      substituteOptions(
        await readFile(path.join(ROOT, 'shared', 'options.js'), 'utf8')
      )
    )

    const manifest = await Bun.file(path.join(srcDir, 'manifest.json')).json()
    if (isEmbedded) {
      manifest.description = `${manifest.description} (with embedded app v${TAUT_VERSION})`
      if (browser !== 'firefox') {
        manifest.version_name = `${manifest.version}-embedded-${TAUT_VERSION}`
      }
      const war = manifest.web_accessible_resources
      if (Array.isArray(war) && typeof war[0] === 'object') {
        // MV3 (Chrome): array of { resources, matches }
        war[0].resources = [...war[0].resources, 'taut.js']
      } else {
        // MV2 (Firefox): plain array of strings
        manifest.web_accessible_resources = [...(war ?? []), 'taut.js']
      }
    }
    const formatted = `${JSON.stringify(manifest, null, 2)}\n`
    entries['manifest.json'] = enc.encode(formatted)

    for (const file of ['content.js', 'background.js']) {
      const srcPath = path.join(srcDir, file)
      const result = await Bun.build({
        entrypoints: [srcPath],
        target: 'browser',
        format: 'iife',
        define: { __TAUT_EMBEDDED__: String(isEmbedded) },
      })
      if (!result.success) {
        console.error(
          `[build-extension] Failed to build ${browser}/${file}:`,
          result.logs
        )
        process.exit(1)
      }
      entries[file] = new Uint8Array(await result.outputs[0].arrayBuffer())
    }

    // For embedded: include taut.debug.js as taut.js
    if (isEmbedded) {
      entries['taut.js'] = new Uint8Array(await Bun.file(TAUT_JS).arrayBuffer())
    }

    // Write unpacked folder and zip
    for (const [name, bytes] of Object.entries(entries)) {
      await Bun.write(path.join(outDir, name), bytes)
    }
    const zip = zipSync(entries)
    const ext = browser === 'firefox' ? 'xpi' : 'zip'
    await Bun.write(path.join(OUT_ROOT, `taut-${browser}${suffix}.${ext}`), zip)

    console.log(`[build-extension] Built ${browser}${suffix}`)
  }
}

console.log('[build-extension] Done!')
