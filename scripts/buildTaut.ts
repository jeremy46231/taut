#!/usr/bin/env bun

// Builds the main Taut app bundle

import fs from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { bundlePlugin } from './pluginBuild'

if (!('Bun' in globalThis)) {
  console.error('This script must be run with Bun.')
  process.exit(1)
}

const ROOT = path.join(import.meta.dir, '..')
const PLUGINS_DIR = path.join(ROOT, 'plugins')
const DIST_DIR = path.join(ROOT, 'dist')

const TAUT_VERSION: string = (
  await Bun.file(path.join(ROOT, 'package.json')).json()
).version

await mkdir(DIST_DIR, { recursive: true })

const TAUT_SOURCE_ORIGIN = 'taut:///'

function rewriteSourcePath(p: string): string {
  const s = p.replace(/^\.\//, '')
  return TAUT_SOURCE_ORIGIN + s
}

function rewriteInlineSourcemaps(code: string): string {
  const re = /sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/g
  return code.replace(re, (_full, b64: string) => {
    const map = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    if (Array.isArray(map.sources)) {
      delete map.sourceRoot
      map.sources = map.sources.map((s: string) => rewriteSourcePath(s))
    }
    const next = Buffer.from(JSON.stringify(map), 'utf8').toString('base64')
    return `sourceMappingURL=data:application/json;base64,${next}`
  })
}

// Step 1: bundle plugins into a Record<string, string>
async function bundlePlugins(debug: boolean): Promise<Record<string, string>> {
  const plugins: Record<string, string> = {}
  if (!fs.existsSync(PLUGINS_DIR)) return plugins

  for (const file of fs
    .readdirSync(PLUGINS_DIR)
    .filter((f) => /\.[tj]sx?$/.test(f) && !f.includes('.disabled.'))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
    const name = path.basename(file, path.extname(file))
    console.log(`[build-taut] Bundling plugin: ${name}`)

    try {
      plugins[name] = await bundlePlugin(path.join(PLUGINS_DIR, file), debug)
    } catch (err) {
      console.error(`[build-taut] Failed to bundle plugin ${name}:`, err)
    }
  }

  return plugins
}

// Step 2: bundle app/main.ts with plugins inlined
async function bundleApp(
  plugins: Record<string, string>,
  debug: boolean
): Promise<string> {
  console.log('[build-taut] Bundling app...')

  const result = await Bun.build({
    entrypoints: [path.join(ROOT, 'app', 'main.ts')],
    target: 'browser',
    format: 'iife',
    minify: !debug,
    sourcemap: debug ? 'inline' : 'none',
    define: {
      __TAUT_BUNDLED_PLUGINS__: JSON.stringify(plugins),
      __TAUT_VERSION__: JSON.stringify(TAUT_VERSION),
      process: 'undefined',
      'import.meta.url': 'self.location.href',
    },
  })

  if (!result.success) {
    console.error('[build-taut] Failed to bundle app:', result.logs)
    throw new Error('App bundle failed')
  }

  let code = await result.outputs[0].text()
  // The app is injected as an inline <script>, which DevTools would
  // otherwise attribute to the page (app.slack.com). Naming it with a
  // sourceURL gives the generated script a stable identity under the taut://
  // tree instead of an anonymous inline entry under Slack.
  if (debug) code += `\n//# sourceURL=${TAUT_SOURCE_ORIGIN}app.js\n`
  return code
}

async function build(debug: boolean) {
  const label = debug ? 'debug' : 'production'
  console.log(`[build-taut] Starting ${label} build...`)

  const plugins = await bundlePlugins(debug)

  console.log(`[build-taut] ${Object.keys(plugins).length} plugins bundled`)

  let code = await bundleApp(plugins, debug)
  if (debug) code = rewriteInlineSourcemaps(code)

  const outFile = debug
    ? path.join(DIST_DIR, 'taut.debug.js')
    : path.join(DIST_DIR, 'taut.js')

  await Bun.write(outFile, code)
  console.log(
    `[build-taut] ${path.basename(outFile)}: ${(Buffer.byteLength(code) / 1024).toFixed(1)} KB`
  )
}

if (import.meta.main) {
  await Promise.all([build(false), build(true)])
  console.log('[build-taut] Done!')
}

export default build
