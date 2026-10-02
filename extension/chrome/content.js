// Taut Chrome content script

// the id (and so storage) depended on the load folder before the manifest `key`, app/chromeMigration.ts saved a copy

// migration to the pinned extension id, remove once users have moved to it
const MIGRATION_DB = 'taut-extension-migration'
const MIGRATION_CHECKED = 'taut-migration-checked'

/** @returns {Promise<unknown>} the snapshot app/chromeMigration.ts wrote, null if there's none */
function readMirror() {
  return new Promise((resolve, reject) => {
    let missing = false
    const open = indexedDB.open(MIGRATION_DB)
    open.onupgradeneeded = () => {
      // it didn't exist, don't create it
      missing = true
      open.transaction?.abort()
    }
    open.onerror = () => (missing ? resolve(null) : reject(open.error))
    open.onsuccess = () => {
      const db = open.result
      if (!db.objectStoreNames.contains('snapshot')) {
        db.close()
        return resolve(null)
      }
      const get = db
        .transaction('snapshot', 'readonly')
        .objectStore('snapshot')
        .get('chrome')
      get.onsuccess = () => {
        db.close()
        resolve(get.result ?? null)
      }
      get.onerror = () => {
        db.close()
        reject(get.error)
      }
    }
  })
}

/** @param {unknown} snapshot @returns {Record<string, string>} */
function snapshotEntries(snapshot) {
  const { version, entries } = /** @type {any} */ (snapshot ?? {})
  if (version !== 1 || typeof entries !== 'object' || !entries) return {}
  /** @type {Record<string, string>} */
  const valid = {}
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === 'string' && key !== MIGRATION_CHECKED) {
      valid[key] = value
    }
  }
  return valid
}

/** runs once per install, whatever the mirror holds then is all it restores */
async function restoreFromMirror() {
  const isChecked = async () =>
    (await chrome.storage.local.get(MIGRATION_CHECKED))[MIGRATION_CHECKED]
  if (await isChecked()) return
  // tabs opening together would each restore, and a late one could overwrite what an earlier tab's Taut saved
  await navigator.locks.request(MIGRATION_DB, async () => {
    if (await isChecked()) return
    /** @type {Record<string, string>} */
    let entries = {}
    try {
      entries = snapshotEntries(await readMirror())
    } catch (e) {
      console.warn("[Taut] Couldn't read the previous extension's storage:", e)
    }
    const existing = await chrome.storage.local.get(null)
    /** @type {Record<string, string>} */
    const missing = {}
    for (const [key, value] of Object.entries(entries)) {
      if (!(key in existing)) missing[key] = value
    }
    try {
      await chrome.storage.local.set({ ...missing, [MIGRATION_CHECKED]: true })
      const count = Object.keys(missing).length
      if (count) {
        console.log(
          `[Taut] Restored ${count} storage entries from the previous extension`
        )
      }
    } catch (e) {
      console.warn('[Taut] Storage restore failed:', e)
      await chrome.storage.local.set({ [MIGRATION_CHECKED]: true })
    }
    // it holds secrets and has done its job, o7
    indexedDB.deleteDatabase(MIGRATION_DB)
  })
}

;(async () => {
  const DEFAULT_URL = __TAUT_EMBEDDED__
    ? chrome.runtime.getURL('taut.js')
    : 'https://taut.jer.app/taut.js'

  document.open()
  document.write('<!DOCTYPE html>')
  document.close()

  const [{ tautUrl }, html] = await Promise.all([
    // migration to the pinned extension id, remove once users have moved to it
    restoreFromMirror()
      .catch((e) => console.warn('[Taut] Storage restore failed:', e))
      .then(() => chrome.storage.local.get({ tautUrl: DEFAULT_URL })),
    fetch(location.href).then((r) => r.text()),
  ])
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.remove()

  const scripts = Array.from(doc.querySelectorAll('script')).map((s) => ({
    src: s.src,
    textContent: s.textContent,
    type: s.getAttribute('type'),
  }))
  doc.querySelectorAll('script').forEach((s) => {
    s.remove()
  })

  // bridge-setup.js defines window.TautBridge, so it goes before taut.js
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

  // document.open() erases the window's listeners, so these go after it
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
      if (msg.method === 'fetch' && result?.ok)
        result = {
          ok: true,
          value: {
            ...result.value,
            body: Uint8Array.fromBase64(result.value.body),
          },
        }
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

  // storage changes from this or another tab go to the page as events
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
