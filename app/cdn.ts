// Taut CDN Dependencies: Monaco and jsonc-parser, loaded from jsDelivr at runtime

export type Monaco = typeof import('monaco-editor')

/** the part of jsonc-parser used, see `initJsonc` */
export type ParseError = { error: number; offset: number; length: number }
type JsoncParser = {
  parse(
    text: string,
    errors: ParseError[],
    options: { allowTrailingComma: boolean }
  ): unknown
  printParseErrorCode(code: number): string
}

const global = globalThis as any

const rgbCsvToHex = (rgb: string) => {
  if (!rgb) return undefined

  const parts = rgb.split(',').map((v) => Number(v.trim()))
  if (parts.length !== 3 || parts.some((v) => Number.isNaN(v))) {
    console.warn('[Taut] Invalid RGB value:', rgb)
    return undefined
  }

  const [r, g, b] = parts

  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

let monaco: Monaco | undefined
let monacoPromise: Promise<Monaco> | null = null
let jsoncPromise: Promise<JsoncParser> | null = null

export function initJsonc(): Promise<JsoncParser> {
  jsoncPromise ??= import(
    // @ts-expect-error a URL, not a module TypeScript can resolve
    'https://cdn.jsdelivr.net/npm/jsonc-parser@3.3.1/+esm'
  ).catch((err: unknown) => {
    jsoncPromise = null
    throw err
  })
  return jsoncPromise
}

export const updateMonacoTheme = () => {
  if (!monaco || !document.body) return
  try {
    const bodyStyle = window.getComputedStyle(document.body)
    const colorScheme = bodyStyle.colorScheme
    const backgroundColor = rgbCsvToHex(
      bodyStyle.getPropertyValue('--sk_primary_background')
    )
    monaco.editor.defineTheme('taut', {
      base: colorScheme === 'dark' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [],
      colors: {
        ...(backgroundColor ? { 'editor.background': backgroundColor } : {}),
      },
    })
  } catch (error) {
    console.error('[Taut] Failed to update Monaco theme:', error)
  }
}

const initTheme = () => {
  updateMonacoTheme()
  const observer = new MutationObserver(updateMonacoTheme)
  observer.observe(document.body, {
    attributeFilter: ['class', 'style'],
  })
}

/** JSON schemas, keyed by the uri of the model they validate */
const jsonSchemas = new Map<string, object>()

function applyJsonSchemas() {
  monaco?.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    trailingCommas: 'error',
    schemas: [...jsonSchemas].map(([uri, schema]) => ({
      uri: `${uri}#schema`,
      fileMatch: [uri],
      schema,
    })),
  })
}

/** validates the JSON model at `uri` against `schema` (null removes it) */
export function setJsonSchema(uri: string, schema: object | null) {
  if (schema) jsonSchemas.set(uri, schema)
  else jsonSchemas.delete(uri)
  applyJsonSchemas()
}

export function initMonaco(): Promise<Monaco> {
  if (monacoPromise) return monacoPromise

  monacoPromise = (async () => {
    // Monaco reads process.env['CI'], which throws on the sealed `process` of Electron's sandbox, but checks vscode.process first
    if (
      typeof global.process !== 'undefined' &&
      global.process.env === undefined
    ) {
      global.vscode ??= {}
      global.vscode.process = { ...global.process, env: {} }
    }

    const monacoLoaderUrl =
      'https://cdn.jsdelivr.net/npm/@monaco-editor/loader@1.7.0/+esm'
    const monacoLoaderModule = await import(monacoLoaderUrl)
    const monacoLoader =
      monacoLoaderModule.default as typeof import('@monaco-editor/loader').default
    const _monaco = await monacoLoader.init()
    monaco = _monaco

    applyJsonSchemas()

    _monaco.css.cssDefaults.setOptions({
      validate: true,
    })

    _monaco.editor.setTheme('taut')

    if (document.body) {
      initTheme()
    } else {
      document.addEventListener('DOMContentLoaded', initTheme)
    }

    global.monaco = _monaco
    global.updateMonacoTheme = updateMonacoTheme

    return _monaco
  })()

  return monacoPromise
}
