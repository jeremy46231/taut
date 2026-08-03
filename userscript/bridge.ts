// Taut userscript backend
// Implements TautBridge interface using GM_* APIs for userscript environment

import { defaultUserCss, emptyConfig } from '../app/bundledData'
import type {
  BlobStore,
  TautBridge,
  TautCookie,
  Unsubscribe,
} from '../shared/TautBridge'

declare const __TAUT_LOADER_VERSION__: string

declare function GM_getValue<T>(key: string, defaultValue?: T): T
declare function GM_setValue(key: string, value: unknown): void
declare function GM_listValues(): string[]
declare function GM_deleteValue(key: string): void
declare function GM_addValueChangeListener(
  key: string,
  callback: (
    key: string,
    oldValue: unknown,
    newValue: unknown,
    remote: boolean
  ) => void
): number
declare function GM_removeValueChangeListener(listenerId: number): void
declare function GM_xmlhttpRequest(details: {
  method?: string
  url: string
  headers?: Record<string, string>
  data?: string
  anonymous?: boolean
  onload?: (response: {
    status: number
    statusText: string
    responseText: string
    responseHeaders: string
  }) => void
  onerror?: (response: { error: string }) => void
}): void

type GMCookie = {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
  sameSite?: string
}
declare const GM_cookie:
  | undefined
  | {
      list(
        details: {
          url?: string
          domain?: string
          name?: string
          path?: string
        },
        cb: (cookies: GMCookie[], error?: string) => void
      ): void
      set(
        details: GMCookie & { url: string },
        cb: (error?: string) => void
      ): void
      delete(
        details: { url?: string; name: string },
        cb: (error?: string) => void
      ): void
    }

const CONFIG_KEY = 'taut-config'
const USER_CSS_KEY = 'taut-user-css'
const SECRET_PREFIX = 'taut-secret:'
const USER_PLUGINS_KEY = 'taut-user-plugins'

function makePrefixedBlobStore(prefix: string): BlobStore {
  return {
    async list() {
      return GM_listValues()
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
    },
    async read(key) {
      return GM_getValue(prefix + key, null)
    },
    async write(key, value) {
      try {
        GM_setValue(prefix + key, value)
        return true
      } catch {
        return false
      }
    },
    async delete(key) {
      try {
        GM_deleteValue(prefix + key)
        return true
      } catch {
        return false
      }
    },
    async clear() {
      try {
        for (const k of GM_listValues()) {
          if (k.startsWith(prefix)) GM_deleteValue(k)
        }
        return true
      } catch {
        return false
      }
    },
  }
}

function makeBlobStore(namespace: string): BlobStore {
  return makePrefixedBlobStore(`taut:blob:${encodeURIComponent(namespace)}:`)
}

const gmCookie = typeof GM_cookie !== 'undefined' ? GM_cookie : null
const secretsBlob = makePrefixedBlobStore(SECRET_PREFIX)

function validUserPlugins(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = Object.create(null)
  for (const [id, code] of Object.entries(value)) {
    if (typeof code === 'string') result[id] = code
  }
  return result
}

function readUserPlugins(): Record<string, string> {
  return validUserPlugins(GM_getValue(USER_PLUGINS_KEY, {}))
}

async function updateUserPlugins(
  update: (plugins: Record<string, string>) => void
): Promise<boolean> {
  if (!navigator.locks) return false
  try {
    return await navigator.locks.request('taut:user-plugins', async () => {
      const plugins = readUserPlugins()
      update(plugins)
      GM_setValue(USER_PLUGINS_KEY, plugins)
      return true
    })
  } catch {
    return false
  }
}

const cookies: TautBridge['cookies'] = gmCookie
  ? {
      get: ({ url, name }) =>
        new Promise((resolve) =>
          gmCookie.list({ url, name }, (list) =>
            resolve((list?.[0] as TautCookie) ?? null)
          )
        ),
      getAll: (details) =>
        new Promise((resolve) =>
          gmCookie.list(details, (list) =>
            resolve((list as TautCookie[]) ?? [])
          )
        ),
      set: (cookie) =>
        new Promise((resolve) =>
          gmCookie.set(cookie as GMCookie & { url: string }, (err) =>
            resolve(!err)
          )
        ),
      remove: ({ url, name }) =>
        new Promise((resolve) =>
          gmCookie.delete({ url, name }, (err) => resolve(!err))
        ),
    }
  : null

export const userscriptBridge: TautBridge = {
  loader: 'userscript' as const,
  loaderVersion: __TAUT_LOADER_VERSION__,
  bridgeVersion: 3,

  cookies,

  async readSecret(key: string): Promise<string | null> {
    return secretsBlob.read(key)
  },

  async writeSecret(key: string, value: string): Promise<boolean> {
    return secretsBlob.write(key, value)
  },

  userPlugins: {
    async list() {
      return Object.keys(readUserPlugins())
    },
    async read(id) {
      return readUserPlugins()[id] ?? null
    },
    async write(id, code) {
      return updateUserPlugins((plugins) => {
        plugins[id] = code
      })
    },
    async delete(id) {
      return updateUserPlugins((plugins) => {
        delete plugins[id]
      })
    },
    onChange(cb): Unsubscribe {
      const listenerId = GM_addValueChangeListener(
        USER_PLUGINS_KEY,
        (_key, oldValue, newValue, remote) => {
          if (!remote) return
          const oldPlugins = validUserPlugins(oldValue)
          const newPlugins = validUserPlugins(newValue)
          for (const id of new Set([
            ...Object.keys(oldPlugins),
            ...Object.keys(newPlugins),
          ])) {
            if (oldPlugins[id] !== newPlugins[id])
              cb(id, newPlugins[id] ?? null)
          }
        }
      )
      return () => GM_removeValueChangeListener(listenerId)
    },
  },

  blobStore: makeBlobStore,

  warnOutdated() {
    alert(
      '[Taut] Your Taut userscript is outdated. Please update it from https://taut.jer.app/taut.user.js'
    )
  },

  PATHS: null,

  async start(): Promise<void> {
    if (!GM_getValue(CONFIG_KEY)) {
      GM_setValue(CONFIG_KEY, emptyConfig)
    }
    if (!GM_getValue(USER_CSS_KEY)) {
      GM_setValue(USER_CSS_KEY, defaultUserCss)
    }
  },

  async readConfigText(): Promise<string> {
    return GM_getValue(CONFIG_KEY, emptyConfig) as string
  },

  async writeConfigText(text: string): Promise<boolean> {
    try {
      GM_setValue(CONFIG_KEY, text)
      return true
    } catch {
      return false
    }
  },

  onConfigTextChange(cb: (text: string) => void): Unsubscribe {
    const listenerId = GM_addValueChangeListener(
      CONFIG_KEY,
      (_key, _oldValue, newValue, remote) => {
        if (remote && typeof newValue === 'string') cb(newValue)
      }
    )
    return () => GM_removeValueChangeListener(listenerId)
  },

  async readUserCss(): Promise<string> {
    return GM_getValue(USER_CSS_KEY, defaultUserCss) as string
  },

  async writeUserCss(text: string): Promise<boolean> {
    try {
      GM_setValue(USER_CSS_KEY, text)
      return true
    } catch {
      return false
    }
  },

  onUserCssChange(cb: (css: string) => void): Unsubscribe {
    const listenerId = GM_addValueChangeListener(
      USER_CSS_KEY,
      (_key, _oldValue, newValue, remote) => {
        if (remote && typeof newValue === 'string') cb(newValue)
      }
    )
    return () => GM_removeValueChangeListener(listenerId)
  },

  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url
    const headers: Record<string, string> = {}
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v
        })
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k] = v
      } else {
        Object.assign(headers, init.headers)
      }
    }
    const hasCookie = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .includes('cookie')
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: (init?.method ?? 'GET').toUpperCase(),
        url,
        headers,
        data: typeof init?.body === 'string' ? init.body : undefined,
        anonymous: hasCookie,
        onload(r) {
          const responseHeaders = new Headers()
          for (const line of r.responseHeaders.trim().split('\r\n')) {
            const idx = line.indexOf(':')
            if (idx > 0)
              responseHeaders.append(
                line.slice(0, idx).trim(),
                line.slice(idx + 1).trim()
              )
          }
          resolve(
            new Response(r.responseText, {
              status: r.status,
              statusText: r.statusText,
              headers: responseHeaders,
            })
          )
        },
        onerror(r) {
          reject(new Error(r.error))
        },
      })
    })
  },
}
