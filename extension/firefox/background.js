// Taut Firefox background script

import { serializeResponse } from '../shared/fetchBody.js'

;(() => {
  const DEFAULT_URL = __TAUT_EMBEDDED__
    ? browser.runtime.getURL('taut.js')
    : 'https://taut.jer.app/taut.js'

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      const filter = browser.webRequest.filterResponseData(details.requestId)
      const decoder = new TextDecoder('utf-8')
      const encoder = new TextEncoder()

      let buffer = ''

      filter.ondata = (event) => {
        buffer += decoder.decode(event.data, { stream: true })
      }

      filter.onstop = async () => {
        buffer += decoder.decode()

        const { tautUrl } = await browser.storage.local.get({
          tautUrl: DEFAULT_URL,
        })

        const doc = new DOMParser().parseFromString(buffer, 'text/html')
        doc
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.remove()

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
        bridgeScript.src = browser.runtime.getURL('bridge-setup.js')
        bridgeScript.setAttribute('onerror', scriptError(bridgeScript.src))
        doc.head.appendChild(bridgeScript)

        const tautScript = doc.createElement('script')
        tautScript.id = 'taut-app'
        tautScript.src = tautUrl
        tautScript.setAttribute('onerror', scriptError(tautScript.src))
        doc.head.appendChild(tautScript)

        for (const { src, textContent, type } of scripts) {
          const s = doc.createElement('script')
          if (type) s.type = type
          if (src) s.src = src
          else if (textContent) s.textContent = textContent
          doc.head.appendChild(s)
        }

        filter.write(
          encoder.encode(`<!DOCTYPE html>${doc.documentElement.outerHTML}`)
        )
        filter.close()
      }
    },
    { urls: ['https://app.slack.com/client/*'], types: ['main_frame'] },
    ['blocking']
  )

  /** @param {string} namespace */
  const blobPrefix = (namespace) =>
    `taut:blob:${encodeURIComponent(namespace)}:`
  /** @param {string} key */
  const blobKey = (key) => encodeURIComponent(key)

  /** @param {string} key @returns {Promise<string | undefined>} */
  const storageGet = (key) => browser.storage.local.get(key).then((r) => r[key])
  /** @param {string} key @param {string} value @returns {Promise<void>} */
  const storageSet = (key, value) => browser.storage.local.set({ [key]: value })

  // let fetchWithCookie send `X-Taut-Cookie`, move it to `Cookie`
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      // only the extension's own requests have tab -1, so pages can't use this
      if (details.tabId !== -1) return {}
      const headers = details.requestHeaders || []
      const marker = headers.find(
        (h) => h.name.toLowerCase() === 'x-taut-cookie'
      )
      if (!marker) return {}
      const kept = headers.filter((h) => {
        const n = h.name.toLowerCase()
        return n !== 'x-taut-cookie' && n !== 'cookie'
      })
      kept.push({ name: 'Cookie', value: marker.value })
      return { requestHeaders: kept }
    },
    { urls: ['https://*.slack.com/*'] },
    ['blocking', 'requestHeaders']
  )

  /**
   * @param {string} url
   * @param {{ method?: string, body?: string, headers?: Record<string, string> }} [init]
   * @returns {Promise<Response>}
   */
  function fetchWithCookie(url, init) {
    const headers = { ...(init?.headers || {}) }
    const cookie = Object.entries(headers).find(
      ([k, _v]) => k.toLowerCase() === 'cookie'
    )?.[1]
    if (!cookie) return fetch(url, { ...init, headers })
    Object.keys(headers)
      .filter((h) => h.toLowerCase() === 'cookie')
      .forEach((h) => {
        delete headers[h]
      })
    headers['X-Taut-Cookie'] = cookie // moved into Cookie by the listener above
    return fetch(url, { ...init, headers, credentials: 'omit' })
  }

  /** @type {import('../shared/rpc').ExtensionRpc} */
  const methods = {
    readConfigText: async () => (await storageGet('taut-config')) ?? '',
    writeConfigText: async (text) => {
      await storageSet('taut-config', text)
      return true
    },
    readUserCss: async () => (await storageGet('taut-user-css')) ?? '',
    writeUserCss: async (text) => {
      await storageSet('taut-user-css', text)
      return true
    },
    readSecret: async (key) => (await storageGet(`taut-secret:${key}`)) ?? null,
    writeSecret: async (key, value) => {
      await storageSet(`taut-secret:${key}`, value)
      return true
    },
    deleteSecret: async (key) => {
      await browser.storage.local.remove(`taut-secret:${key}`)
      return true
    },
    listUserPlugins: async () => {
      const all = await browser.storage.local.get(null)
      return Object.keys(all)
        .filter((key) => key.startsWith('taut-user-plugin:'))
        .map((key) => key.slice('taut-user-plugin:'.length))
    },
    readUserPlugin: async (id) =>
      (await storageGet(`taut-user-plugin:${id}`)) ?? null,
    writeUserPlugin: async (id, code) => {
      await storageSet(`taut-user-plugin:${id}`, code)
      return true
    },
    deleteUserPlugin: async (id) => {
      await browser.storage.local.remove(`taut-user-plugin:${id}`)
      return true
    },
    blobList: async (namespace) => {
      const prefix = blobPrefix(namespace)
      const all = await browser.storage.local.get(null)
      return Object.keys(all)
        .filter((k) => k.startsWith(prefix))
        .map((k) => decodeURIComponent(k.slice(prefix.length)))
    },
    blobRead: async (namespace, key) =>
      (await storageGet(blobPrefix(namespace) + blobKey(key))) ?? null,
    blobWrite: async (namespace, key, value) => {
      await storageSet(blobPrefix(namespace) + blobKey(key), value)
      return true
    },
    blobDelete: async (namespace, key) => {
      await browser.storage.local.remove(blobPrefix(namespace) + blobKey(key))
      return true
    },
    blobClear: async (namespace) => {
      const prefix = blobPrefix(namespace)
      const all = await browser.storage.local.get(null)
      const keys = Object.keys(all).filter((k) => k.startsWith(prefix))
      await browser.storage.local.remove(keys)
      return true
    },
    cookieGet: (details) =>
      browser.cookies
        .get({ url: details.url, name: details.name })
        .then((c) => c ?? null),
    cookieGetAll: (details) => browser.cookies.getAll(details),
    cookieSet: (cookie) => browser.cookies.set(cookie).then((c) => c != null),
    cookieRemove: (details) =>
      browser.cookies
        .remove({ url: details.url, name: details.name })
        .then((r) => r != null),
    fetch: async (url, init) =>
      serializeResponse(await fetchWithCookie(url, init)),
  }

  browser.runtime.onMessage.addListener((message) => {
    const method = /** @type {import('../shared/rpc').RpcMethod} */ (
      message.method
    )
    const fn = /** @type {(...args: unknown[]) => Promise<unknown>} */ (
      methods[method]
    )
    if (!fn) return undefined

    return Promise.resolve()
      .then(() => fn(...message.args))
      .then((value) => ({ ok: true, value }))
      .catch((e) => ({ ok: false, error: String(e) }))
  })
})()
