// Builds the Taut userscript

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import { type Variant, variantSuffix } from '../lib/artifacts.ts'
import { renderOptions } from '../lib/options.ts'
import { DIST, TAUT_JS, USERSCRIPT } from '../lib/paths.ts'
import { versions } from '../lib/versions.ts'

async function buildVariant(variant: Variant, headerRaw: string) {
  const embedded = variant === 'embedded'
  const suffix = variantSuffix(variant)

  let header = headerRaw
    .replace(/\$VERSION/g, versions.userscript)
    .replace(
      /\$DESCRIPTION_SUFFIX/g,
      embedded ? ` (with embedded app v${versions.taut})` : ''
    )
  if (embedded) {
    header = header.replace(/^\/\/ @(?:updateURL|downloadURL)\s+.*\n/gm, '')
  }

  const options = await renderOptions('userscript', embedded)
  const optionsHtml = options.html.replace(
    '<script src="options.js"></script>',
    `<script>\n${options.js}\n</script>`
  )

  const tautAppJs = embedded ? await readFile(TAUT_JS, 'utf8') : ''

  const result = await build({
    entryPoints: [path.join(USERSCRIPT, 'main.ts')],
    bundle: true,
    write: false,
    platform: 'browser',
    minify: true,
    format: 'iife',
    define: {
      __TAUT_LOADER_VERSION__: JSON.stringify(versions.userscript),
      __TAUT_OPTIONS_HTML__: JSON.stringify(optionsHtml),
      __TAUT_EMBEDDED__: String(embedded),
      __TAUT_APP_JS__: JSON.stringify(tautAppJs),
    },
  })

  const userscript = `${header}\n${result.outputFiles[0].text}`
  const outFile = path.join(DIST, 'userscript', `taut${suffix}.user.js`)
  await mkdir(path.dirname(outFile), { recursive: true })
  await writeFile(outFile, userscript)
  console.log(
    `[build-userscript] dist/userscript/${path.basename(outFile)}: ${(Buffer.byteLength(userscript) / 1024).toFixed(1)} KB`
  )
}

export async function buildUserscript(variants: Variant[]) {
  const headerRaw = await readFile(path.join(USERSCRIPT, 'header.ts'), 'utf8')
  await Promise.all(variants.map((v) => buildVariant(v, headerRaw)))
}
