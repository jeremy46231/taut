// Builds the Chrome and Firefox extensions (unpacked folder + zip/xpi each)

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { zipSync } from 'fflate'
import { type Variant, variantSuffix } from '../lib/artifacts.ts'
import { readJson } from '../lib/fs.ts'
import { renderOptions } from '../lib/options.ts'
import { ASSETS, DIST, EXTENSION, TAUT_DEBUG_JS } from '../lib/paths.ts'
import { versions } from '../lib/versions.ts'

const OUT_ROOT = path.join(DIST, 'extension')

export async function buildExtension(variants: Variant[]) {
  const bridgeTemplate = await readFile(
    path.join(EXTENSION, 'shared', 'bridge-setup.template.js'),
    'utf8'
  )
  const enc = new TextEncoder()

  for (const { browser, loaderName, loaderVersion, zipExt } of [
    {
      browser: 'chrome',
      loaderName: 'chrome-extension',
      loaderVersion: versions.chromeExtension,
      zipExt: 'zip',
    },
    {
      browser: 'firefox',
      loaderName: 'firefox-extension',
      loaderVersion: versions.firefoxExtension,
      zipExt: 'xpi',
    },
  ] as const) {
    const srcDir = path.join(EXTENSION, browser)

    for (const variant of variants) {
      const isEmbedded = variant === 'embedded'
      const bridgeSetup = bridgeTemplate
        .replace(/__TAUT_LOADER__/g, loaderName)
        .replace(/__TAUT_LOADER_VERSION__/g, loaderVersion)
        .replace(/__TAUT_EMBEDDED__/g, String(isEmbedded))
      const suffix = variantSuffix(variant)
      const outDir = path.join(OUT_ROOT, `${browser}${suffix}`)
      const zipFile = path.join(OUT_ROOT, `taut-${browser}${suffix}.${zipExt}`)
      await rm(outDir, { recursive: true, force: true })
      await rm(zipFile, { force: true })
      await mkdir(outDir, { recursive: true })

      const entries: Record<string, Uint8Array> = {}
      entries['bridge-setup.js'] = enc.encode(bridgeSetup)

      for (const size of [16, 32, 48, 128]) {
        entries[`icons/icon-${size}.png`] = await readFile(
          path.join(ASSETS, 'icons', `icon-${size}.png`)
        )
      }

      const options = await renderOptions(browser, isEmbedded)
      entries['options.html'] = enc.encode(options.html)
      entries['options.js'] = enc.encode(options.js)

      const manifest = await readJson(path.join(srcDir, 'manifest.json'))
      if (isEmbedded) {
        manifest.description = `${manifest.description} (with embedded app v${versions.taut})`
        if (browser === 'firefox') {
          delete manifest.browser_specific_settings.gecko.update_url
        } else {
          manifest.version_name = `${manifest.version}-embedded-${versions.taut}`
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
      entries['manifest.json'] = enc.encode(
        `${JSON.stringify(manifest, null, 2)}\n`
      )

      for (const file of ['content.js', 'background.js']) {
        const result = await build({
          entryPoints: [path.join(srcDir, file)],
          bundle: true,
          write: false,
          platform: 'browser',
          format: 'iife',
          define: { __TAUT_EMBEDDED__: String(isEmbedded) },
        })
        entries[file] = result.outputFiles[0].contents
      }

      // embedded builds carry the debug bundle so sourcemaps work offline
      if (isEmbedded) {
        entries['taut.js'] = await readFile(TAUT_DEBUG_JS)
      }

      for (const [name, bytes] of Object.entries(entries)) {
        await mkdir(path.dirname(path.join(outDir, name)), { recursive: true })
        await writeFile(path.join(outDir, name), bytes)
      }
      await writeFile(zipFile, zipSync(entries))

      console.log(`[build-extension] dist/extension/${path.basename(zipFile)}`)
    }

    if (browser === 'firefox') await writeFirefoxUpdates(loaderVersion)
  }
}

async function writeFirefoxUpdates(version: string) {
  const { id } = (
    await readJson(path.join(EXTENSION, 'firefox', 'manifest.json'))
  ).browser_specific_settings.gecko
  const file = path.join(OUT_ROOT, 'taut-firefox-updates.json')
  const updates = {
    addons: {
      [id]: {
        updates: [
          { version, update_link: 'https://taut.jer.app/taut-firefox.xpi' },
        ],
      },
    },
  }
  await writeFile(file, `${JSON.stringify(updates, null, 2)}\n`)
  console.log(`[build-extension] dist/extension/${path.basename(file)}`)
}
