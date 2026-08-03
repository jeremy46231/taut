#!/usr/bin/env bun

// Builds the Taut userscript

import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

if (!('Bun' in globalThis)) {
  console.error('This script must be run with Bun.')
  process.exit(1)
}

const ROOT = path.join(import.meta.dir, '..')
const USERSCRIPT_SRC = path.join(ROOT, 'userscript')
const DIST = path.join(ROOT, 'dist')
const OUT = path.join(DIST, 'userscript')
const TAUT_JS = path.join(DIST, 'taut.js')

const TAUT_VERSION: string = (
  await Bun.file(path.join(ROOT, 'package.json')).json()
).version
const LOADER_VERSION: string = (
  await Bun.file(path.join(USERSCRIPT_SRC, 'version.json')).json()
).version

await mkdir(OUT, { recursive: true })

const headerRaw = await readFile(path.join(USERSCRIPT_SRC, 'header.ts'), 'utf8')
const optionsHtmlRaw = await readFile(
  path.join(ROOT, 'shared', 'options.html'),
  'utf8'
)
const optionsJsRaw = await readFile(
  path.join(ROOT, 'shared', 'options.js'),
  'utf8'
)

async function build(embedded: boolean) {
  const suffix = embedded ? '-embedded' : ''

  if (embedded && !existsSync(TAUT_JS)) {
    console.error(
      '[build-userscript] Missing dist/taut.js, run `bun build:taut` first.'
    )
    process.exit(1)
  }

  let header = headerRaw
    .replace(/\$VERSION/g, LOADER_VERSION)
    .replace(
      /\$DESCRIPTION_SUFFIX/g,
      embedded ? ` (with embedded app v${TAUT_VERSION})` : ''
    )

  if (embedded) {
    header = header.replace(/^\/\/ @(?:updateURL|downloadURL)\s+.*\n/gm, '')
  }

  const substituteOptions = (src: string) =>
    src
      .replace(/__TAUT_EMBEDDED__/g, String(embedded))
      .replace(/__TAUT_RUNTIME__/g, "'userscript'")
      .replace(
        /__TAUT_EMBEDDED_VERSION__/g,
        embedded ? `'${TAUT_VERSION}'` : "''"
      )

  const optionsJs = substituteOptions(optionsJsRaw)
  const optionsHtml = substituteOptions(optionsHtmlRaw).replace(
    '<script src="options.js"></script>',
    `<script>\n${optionsJs}\n</script>`
  )

  const tautAppJs = embedded ? await readFile(TAUT_JS, 'utf8') : ''

  const result = await Bun.build({
    entrypoints: [path.join(USERSCRIPT_SRC, 'main.ts')],
    target: 'browser',
    minify: true,
    format: 'iife',
    define: {
      __TAUT_VERSION__: JSON.stringify(TAUT_VERSION),
      __TAUT_LOADER_VERSION__: JSON.stringify(LOADER_VERSION),
      __TAUT_BUNDLED_PLUGINS__: JSON.stringify({}),
      __TAUT_OPTIONS_HTML__: JSON.stringify(optionsHtml),
      __TAUT_EMBEDDED__: String(embedded),
      __TAUT_APP_JS__: JSON.stringify(tautAppJs),
    },
  })

  if (!result.success) {
    console.error(
      `[build-userscript] ${embedded ? 'embedded' : 'standard'} build failed:`
    )
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }

  const code = await result.outputs[0].text()
  const userscript = `${header}\n${code}`

  const outFile = path.join(OUT, `taut${suffix}.user.js`)
  await Bun.write(outFile, userscript)
  console.log(
    `[build-userscript] dist/userscript/taut${suffix}.user.js: ${(Buffer.byteLength(userscript) / 1024).toFixed(1)} KB`
  )
}

const standardOnly = process.argv.includes('--standard-only')
await Promise.all(standardOnly ? [build(false)] : [build(false), build(true)])
console.log('[build-userscript] Done!')
