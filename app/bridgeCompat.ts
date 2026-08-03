import type { BlobStore, TautBridge } from '../shared/TautBridge'

/**
 * after `normalizeBridge()`, all methods there + boolean for supported features
 */
export type NormalizedBridge = TautBridge & {
  /** bridgeVersion >= 3 */
  readonly supportsUserPlugins: boolean
}

const V2_BLOB_PREFIX = 'taut:bridge-v2:blob:'

function localStorageBlobStore(namespace: string): BlobStore {
  const prefix = `${V2_BLOB_PREFIX}${encodeURIComponent(namespace)}:`
  const storageKey = (key: string) => prefix + encodeURIComponent(key)

  return {
    async list() {
      try {
        const keys: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const storedKey = localStorage.key(i)
          if (!storedKey?.startsWith(prefix)) continue
          try {
            keys.push(decodeURIComponent(storedKey.slice(prefix.length)))
          } catch {}
        }
        return keys
      } catch {
        return []
      }
    },
    async read(key) {
      try {
        return localStorage.getItem(storageKey(key))
      } catch {
        return null
      }
    },
    async write(key, value) {
      try {
        localStorage.setItem(storageKey(key), value)
        return true
      } catch {
        return false
      }
    },
    async delete(key) {
      try {
        localStorage.removeItem(storageKey(key))
        return true
      } catch {
        return false
      }
    },
    async clear() {
      try {
        const keys: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key?.startsWith(prefix)) keys.push(key)
        }
        for (const key of keys) localStorage.removeItem(key)
        return true
      } catch {
        return false
      }
    },
  }
}

/** Normalize either supported public bridge contract without modifying it. */
export function normalizeBridge(raw: TautBridge): NormalizedBridge {
  const call =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R =>
      fn.apply(raw, args)
  const cookies = raw.cookies
    ? {
        get: raw.cookies.get.bind(raw.cookies),
        getAll: raw.cookies.getAll.bind(raw.cookies),
        set: raw.cookies.set.bind(raw.cookies),
        remove: raw.cookies.remove.bind(raw.cookies),
      }
    : null
  const common = {
    loader: raw.loader,
    loaderVersion: raw.loaderVersion,
    bridgeVersion: raw.bridgeVersion,
    warnOutdated: call(raw.warnOutdated),
    start: call(raw.start),
    readConfigText: call(raw.readConfigText),
    writeConfigText: call(raw.writeConfigText),
    onConfigTextChange: call(raw.onConfigTextChange),
    readUserCss: call(raw.readUserCss),
    writeUserCss: call(raw.writeUserCss),
    onUserCssChange: call(raw.onUserCssChange),
    fetch: call(raw.fetch),
    cookies,
    readSecret: call(raw.readSecret),
    writeSecret: call(raw.writeSecret),
    PATHS: raw.PATHS,
  }

  if (raw.bridgeVersion >= 3) {
    return {
      ...common,
      supportsUserPlugins: true,
      userPlugins: {
        list: raw.userPlugins.list.bind(raw.userPlugins),
        read: raw.userPlugins.read.bind(raw.userPlugins),
        write: raw.userPlugins.write.bind(raw.userPlugins),
        delete: raw.userPlugins.delete.bind(raw.userPlugins),
        onChange: raw.userPlugins.onChange.bind(raw.userPlugins),
      },
      blobStore: raw.blobStore.bind(raw),
    }
  }

  return {
    ...common,
    supportsUserPlugins: false,
    userPlugins: {
      async list() {
        return []
      },
      async read() {
        return null
      },
      async write() {
        return false
      },
      async delete() {
        return false
      },
      onChange() {
        return () => {}
      },
    },
    blobStore: localStorageBlobStore,
  }
}
