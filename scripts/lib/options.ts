import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { SHARED } from './paths.ts'
import { versions } from './versions.ts'

export type Runtime = 'chrome' | 'firefox' | 'electron' | 'userscript'

/** fills in the build-time constants of shared/options.{html,js} for one loader */
export async function renderOptions(runtime: Runtime, embedded: boolean) {
  const substitute = (src: string) =>
    src
      .replace(/__TAUT_EMBEDDED__/g, String(embedded))
      .replace(/__TAUT_RUNTIME__/g, `'${runtime}'`)
      .replace(
        /__TAUT_EMBEDDED_VERSION__/g,
        embedded ? `'${versions.taut}'` : "''"
      )
  const [html, js] = await Promise.all(
    ['options.html', 'options.js'].map((f) =>
      readFile(path.join(SHARED, f), 'utf8')
    )
  )
  return { html: substitute(html), js: substitute(js) }
}
