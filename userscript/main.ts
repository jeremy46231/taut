// Taut Userscript main

import { userscriptBridge } from './bridge'

declare const unsafeWindow: Window
declare function GM_getValue<T>(key: string, defaultValue: T): T
declare function GM_setValue(key: string, value: unknown): void
declare function GM_registerMenuCommand(name: string, fn: () => void): void
declare function GM_openInTab(url: string, opts?: { active?: boolean }): void
declare const __TAUT_OPTIONS_HTML__: string
declare const __TAUT_EMBEDDED__: boolean
declare const __TAUT_APP_JS__: string

const OFFICIAL_URL = 'https://taut.jer.app/taut.js'
const EMBEDDED_SENTINEL = '<embedded>'
const DEFAULT_URL = __TAUT_EMBEDDED__ ? EMBEDDED_SENTINEL : OFFICIAL_URL
const OPTIONS_URL = 'https://taut.jer.app/options'

// Expose tautPrefs on the real window
unsafeWindow.tautPrefs = {
  getUrl: () => Promise.resolve(GM_getValue('tautUrl', DEFAULT_URL)),
  setUrl: (url) => {
    GM_setValue('tautUrl', url)
    return Promise.resolve()
  },
}

if (location.href.startsWith(OPTIONS_URL)) {
  document.open()
  document.write(__TAUT_OPTIONS_HTML__)
  document.close()
} else {
  GM_registerMenuCommand('Taut Options', () =>
    GM_openInTab(OPTIONS_URL, { active: true })
  )

  unsafeWindow.TautBridge = userscriptBridge

  document.open()
  document.write('<!DOCTYPE html>')
  document.close()
  ;(async () => {
    const tautUrl = GM_getValue('tautUrl', DEFAULT_URL)
    const useEmbedded = __TAUT_EMBEDDED__ && tautUrl === EMBEDDED_SENTINEL

    let html: string
    try {
      html = await fetch(location.href).then((r) => r.text())
    } catch (e) {
      console.error('[Taut] Failed to fetch page HTML:', e)
      return
    }

    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.remove()

    // Collect and remove all script elements
    const scripts = Array.from(doc.querySelectorAll('script')).map((s) => ({
      src: (s as HTMLScriptElement).src,
      textContent: s.textContent,
      type: s.getAttribute('type'),
    }))
    doc.querySelectorAll('script').forEach((s) => {
      s.remove()
    })

    // Inject taut.js, then Slack's scripts
    const tautScript = doc.createElement('script')
    tautScript.id = 'taut-app'
    if (useEmbedded) {
      tautScript.textContent = __TAUT_APP_JS__
    } else {
      const resolvedUrl = tautUrl === EMBEDDED_SENTINEL ? OFFICIAL_URL : tautUrl
      const scriptError = (url: string) =>
        `alert('[Taut] Failed to load a script.\\n\\nURL: ' + ${JSON.stringify(url)} + '\\n\\n${url.includes('://localhost') ? 'Make sure your server is running.' : 'Ask in #taut for help.'}')`
      tautScript.src = resolvedUrl
      tautScript.setAttribute('onerror', scriptError(resolvedUrl))
    }
    doc.head.appendChild(tautScript)

    for (const { src, textContent, type } of scripts) {
      const s = doc.createElement('script')
      if (type) s.type = type
      if (src) s.src = src
      else if (textContent) s.textContent = textContent
      doc.head.appendChild(s)
    }

    // Reconstruct the document
    document.open()
    document.write(`<!DOCTYPE html>${doc.documentElement.outerHTML}`)
    document.close()

    console.log(
      '[Taut] Document reconstructed with CSP removed and taut.js injected'
    )
  })()
}
