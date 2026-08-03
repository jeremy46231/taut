// Taut Firefox background script

;(() => {
  const DEFAULT_URL = __TAUT_EMBEDDED__
    ? browser.runtime.getURL('taut.js')
    : 'https://taut.jer.app/taut.js'

  /** @type {browser.webRequest.RequestFilter} */
  const SLACK_FILTER = {
    urls: ['https://app.slack.com/*'],
    types: ['main_frame'],
  }

  // Rewrite the response body: remove CSP meta tag, inject bridge-setup + taut.js
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
    SLACK_FILTER,
    ['blocking']
  )

  const CONFIG_KEY = 'taut-config'
  const CSS_KEY = 'taut-user-css'
  const SECRET_PREFIX = 'taut-secret:'
  const USER_PLUGIN_PREFIX = 'taut-user-plugin:'
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
      // Only extensions can trigger this (tab -1)
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
    readConfigText: async () => (await storageGet(CONFIG_KEY)) ?? '',
    writeConfigText: async (text) => {
      await storageSet(CONFIG_KEY, text)
      return true
    },
    readUserCss: async () => (await storageGet(CSS_KEY)) ?? '',
    writeUserCss: async (text) => {
      await storageSet(CSS_KEY, text)
      return true
    },
    readSecret: async (key) => (await storageGet(SECRET_PREFIX + key)) ?? null,
    writeSecret: async (key, value) => {
      await storageSet(SECRET_PREFIX + key, value)
      return true
    },
    listUserPlugins: async () => {
      const all = await browser.storage.local.get(null)
      return Object.keys(all)
        .filter((key) => key.startsWith(USER_PLUGIN_PREFIX))
        .map((key) => key.slice(USER_PLUGIN_PREFIX.length))
    },
    readUserPlugin: async (id) =>
      (await storageGet(USER_PLUGIN_PREFIX + id)) ?? null,
    writeUserPlugin: async (id, code) => {
      await storageSet(USER_PLUGIN_PREFIX + id, code)
      return true
    },
    deleteUserPlugin: async (id) => {
      await browser.storage.local.remove(USER_PLUGIN_PREFIX + id)
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
    fetch: async (url, init) => {
      const response = await fetchWithCookie(url, init)
      /** @type {Record<string, string>} */
      const headers = {}
      response.headers.forEach((value, key) => {
        headers[key] = value
      })
      return {
        status: response.status,
        statusText: response.statusText,
        headers,
        body: await response.text(),
      }
    },
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
