// Taut Chrome background service worker

const CONFIG_KEY = 'taut-config'
const CSS_KEY = 'taut-user-css'
const SECRET_PREFIX = 'taut-secret:'
const BACKGROUND_USER_PLUGIN_PREFIX = 'taut-user-plugin:'
/** @param {string} namespace */
const blobPrefix = (namespace) => `taut:blob:${encodeURIComponent(namespace)}:`
/** @param {string} key */
const blobKey = (key) => encodeURIComponent(key)

/** @param {string} key @returns {Promise<string | undefined>} */
const storageGet = (key) =>
  chrome.storage.local
    .get(key)
    .then((r) => /** @type {string | undefined} */ (r[key]))
/** @param {string} key @param {string} value @returns {Promise<void>} */
const storageSet = (key, value) => chrome.storage.local.set({ [key]: value })

let nextRuleId = Math.floor(Math.random() * 1_000_000_000) + 1

/**
 * fetch() that honors a custom `Cookie` request header
 * uses a temp declarativeNetRequest session rule, scoped to a nonce
 * @param {string} url
 * @param {{ method?: string, body?: string, headers?: Record<string, string> }} [init]
 * @returns {Promise<Response>}
 */
async function fetchWithCookie(url, init) {
  const headers = { ...(init?.headers || {}) }
  const cookie = headers.Cookie ?? headers.cookie
  delete headers.Cookie
  delete headers.cookie
  if (!cookie) return fetch(url, { ...init, headers })

  const ruleId = nextRuleId++
  const nonce = crypto.randomUUID()
  const u = new URL(url)
  u.searchParams.set('__taut_req', nonce)

  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [
      {
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'cookie', operation: 'set', value: cookie },
          ],
        },
        // Match only this request
        condition: {
          urlFilter: `__taut_req=${nonce}`,
          tabIds: [-1],
          requestDomains: ['slack.com'],
        },
      },
    ],
  })
  try {
    return await fetch(u.toString(), { ...init, headers, credentials: 'omit' })
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
    })
  }
}

/** @param {Response} response */
async function serializeResponse(response) {
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
    const all = await chrome.storage.local.get(null)
    return Object.keys(all)
      .filter((key) => key.startsWith(BACKGROUND_USER_PLUGIN_PREFIX))
      .map((key) => key.slice(BACKGROUND_USER_PLUGIN_PREFIX.length))
  },
  readUserPlugin: async (id) =>
    (await storageGet(BACKGROUND_USER_PLUGIN_PREFIX + id)) ?? null,
  writeUserPlugin: async (id, code) => {
    await storageSet(BACKGROUND_USER_PLUGIN_PREFIX + id, code)
    return true
  },
  deleteUserPlugin: async (id) => {
    await chrome.storage.local.remove(BACKGROUND_USER_PLUGIN_PREFIX + id)
    return true
  },
  blobList: async (namespace) => {
    const prefix = blobPrefix(namespace)
    const all = await chrome.storage.local.get(null)
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
    await chrome.storage.local.remove(blobPrefix(namespace) + blobKey(key))
    return true
  },
  blobClear: async (namespace) => {
    const prefix = blobPrefix(namespace)
    const all = await chrome.storage.local.get(null)
    const keys = Object.keys(all).filter((k) => k.startsWith(prefix))
    await chrome.storage.local.remove(keys)
    return true
  },
  cookieGet: (details) =>
    chrome.cookies
      .get({ url: details.url, name: details.name })
      .then((c) => c ?? null),
  cookieGetAll: (details) => chrome.cookies.getAll(details),
  cookieSet: (cookie) => chrome.cookies.set(cookie).then((c) => c != null),
  cookieRemove: (details) =>
    chrome.cookies
      .remove({ url: details.url, name: details.name })
      .then((r) => r != null),
  fetch: async (url, init) =>
    serializeResponse(await fetchWithCookie(url, init)),
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const method = /** @type {import('../shared/rpc').RpcMethod} */ (
    message.method
  )
  const fn = /** @type {(...args: unknown[]) => Promise<unknown>} */ (
    methods[method]
  )
  if (!fn) return false

  Promise.resolve()
    .then(() => fn(...message.args))
    .then((value) => sendResponse({ ok: true, value }))
    .catch((e) => sendResponse({ ok: false, error: String(e) }))
  return true // keep the channel open for the async response
})
