// Taut CDN Dependencies
// Loads Monaco editor and jsonc-parser from CDN at runtime

export type Monaco = typeof import('monaco-editor')
export type JsoncParser = typeof import('jsonc-parser')
export type JsoncNode = import('jsonc-parser').Node

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
  if (jsoncPromise) return jsoncPromise
  jsoncPromise = (async () => {
    // @ts-expect-error
    return await import('https://cdn.jsdelivr.net/npm/jsonc-parser@3.3.1/+esm')
  })()
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

export function initMonaco(): Promise<Monaco> {
  if (monacoPromise) return monacoPromise

  monacoPromise = (async () => {
    // Electron's sandboxed renderer exposes a sealed `process` with no `env`, which causes
    // Monaco's platform.ts to throw accessing process.env['CI']. Monaco checks globalThis.vscode.process
    // first, so we make a fake one lol
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

    _monaco.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: true,
      trailingCommas: 'ignore',
    })

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
