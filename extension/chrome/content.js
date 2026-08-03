// Taut Chrome content script

;(async () => {
  const DEFAULT_URL = __TAUT_EMBEDDED__
    ? chrome.runtime.getURL('taut.js')
    : 'https://taut.jer.app/taut.js'

  document.open()
  document.write('<!DOCTYPE html>')
  document.close()

  const [{ tautUrl }, html] = await Promise.all([
    chrome.storage.local.get({ tautUrl: DEFAULT_URL }),
    fetch(location.href).then((r) => r.text()),
  ])
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.remove()

  // Collect and remove all script elements
  const scripts = Array.from(doc.querySelectorAll('script')).map((s) => ({
    src: s.src,
    textContent: s.textContent,
    type: s.getAttribute('type'),
  }))
  doc.querySelectorAll('script').forEach((s) => {
    s.remove()
  })

  // Inject: bridge-setup (sets window.TautBridge), then taut.js, then Slack's scripts
  const scriptError = (/** @type {string} */ url) =>
    `alert('[Taut] Failed to load a script.\\n\\nURL: ' + ${JSON.stringify(url)} + '\\n\\n${url.includes('://localhost') ? 'Make sure your server is running.' : 'Ask in #taut for help.'}')`

  const bridgeScript = doc.createElement('script')
  bridgeScript.id = 'taut-bridge'
  bridgeScript.src = chrome.runtime.getURL('bridge-setup.js')
  bridgeScript.setAttribute('onerror', scriptError(bridgeScript.src))
  doc.head.appendChild(bridgeScript)

  const tautScript = doc.createElement('script')
  tautScript.id = 'taut-app'
  tautScript.src = /** @type {string} */ (tautUrl)
  tautScript.setAttribute('onerror', scriptError(tautScript.src))
  doc.head.appendChild(tautScript)

  for (const { src, textContent, type } of scripts) {
    const s = doc.createElement('script')
    if (type) s.type = type
    if (src) s.src = src
    else if (textContent) s.textContent = textContent
    doc.head.appendChild(s)
  }

  document.open()
  document.write(`<!DOCTYPE html>${doc.documentElement.outerHTML}`)
  document.close()

  // Connect the bridge to the backend
  // these event listeners must be set up after the document.write shenanigans above

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return
    const msg = event.data
    if (!msg?.__taut || msg.kind !== 'rpc') return

    let result
    try {
      result = await chrome.runtime.sendMessage({
        method: msg.method,
        args: msg.args,
      })
    } catch (e) {
      result = { ok: false, error: String(e) }
    }
    window.postMessage({
      __taut: true,
      kind: 'rpc:result',
      id: msg.id,
      ...result,
    })
  })

  // Forward storage changes (this or another tab) to the page as events
  const USER_PLUGIN_PREFIX = 'taut-user-plugin:'
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key.startsWith(USER_PLUGIN_PREFIX)) {
        window.postMessage({
          __taut: true,
          kind: 'event',
          name: 'userPlugin.changed',
          payload: {
            id: key.slice(USER_PLUGIN_PREFIX.length),
            code: newValue ?? null,
          },
        })
        continue
      }
      window.postMessage({
        __taut: true,
        kind: 'event',
        name: 'storage.changed',
        payload: { key, newValue: newValue ?? null },
      })
    }
  })
})()
