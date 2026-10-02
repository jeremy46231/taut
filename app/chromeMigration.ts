// unpinned extension ids follow the folder, so storage is mirrored to IndexedDB for the pinned build to restore, remove this file once users have moved to the pinned extension

import { SECRET_KEY as ACCOUNTS_SECRET } from './api/accountSwitcher'
import type { NormalizedBridge } from './bridgeCompat'
import type { PluginManager } from './pluginManager'

/** set by scripts/build/taut.ts from extension/chrome/manifest.json */
declare const __TAUT_CHROME_EXTENSION_ID__: string

// batches bursts of writes, hiding the tab writes right away
const WRITE_DELAY = 5_000

export interface ExtensionSnapshot {
  version: 1
  at: number
  extensionId: string
  /** chrome.storage.local keys and values, see extension/chrome/background.js */
  entries: Record<string, string>
}

function runningExtensionId(): string | null {
  const script = document.getElementById('taut-bridge')
  const src = script instanceof HTMLScriptElement ? script.src : ''
  return src.match(/^chrome-extension:\/\/([a-p]{32})\//)?.[1] ?? null
}

// the storage layout of extension/chrome/background.js
const blobKey = (namespace: string, key: string) =>
  `taut:blob:${encodeURIComponent(namespace)}:${encodeURIComponent(key)}`

// blob namespaces besides each plugin's storage (caches are left behind)
const NAMESPACES = ['telemetry', 'patch_targets', 'whats_new']

function isMirrored(key: string): boolean {
  if (['taut-config', 'taut-user-css', 'tautUrl'].includes(key)) return true
  if (key.startsWith('taut-secret:') || key.startsWith('taut-user-plugin:')) {
    return true
  }
  const blob = key.match(/^taut:blob:([^:]*):/)
  if (!blob) return false
  const namespace = decodeURIComponent(blob[1])
  return NAMESPACES.includes(namespace) || /^plugin:.*:storage$/.test(namespace)
}

/** the value a snapshot keeps for a storage value, null to leave it out */
function mirroredValue(key: string, value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  // the loader option, unless it points into the old extension (embedded)
  if (key === 'tautUrl' && !/^https?:/.test(value)) return null
  return value
}

async function snapshot(
  bridge: NormalizedBridge,
  pluginManager: PluginManager
): Promise<Record<string, string>> {
  const entries: Record<string, string> = {}
  const put = (key: string, value: string | null | undefined) => {
    const kept = mirroredValue(key, value)
    if (kept !== null) entries[key] = kept
  }

  put('taut-config', await bridge.readConfigText())
  put('taut-user-css', await bridge.readUserCss())
  // every secret the app writes
  for (const key of [ACCOUNTS_SECRET, ...pluginManager.pluginSecretNames()]) {
    put(`taut-secret:${key}`, await bridge.readSecret(key))
  }
  for (const id of await bridge.userPlugins.list()) {
    put(`taut-user-plugin:${id}`, await bridge.userPlugins.read(id))
  }

  const namespaces = new Set(NAMESPACES)
  for (const plugin of pluginManager.pluginInfoStore.get()) {
    namespaces.add(`plugin:${plugin.id}:storage`)
  }
  for (const namespace of namespaces) {
    const blob = bridge.blobStore(namespace)
    for (const key of await blob.list()) {
      put(blobKey(namespace, key), await blob.read(key))
    }
  }

  const appScript = document.getElementById('taut-app')
  if (appScript instanceof HTMLScriptElement) put('tautUrl', appScript.src)

  return entries
}

// keep in sync with extension/chrome/content.js
function writeSnapshot(value: ExtensionSnapshot): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('taut-extension-migration', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('snapshot')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('snapshot', 'readwrite')
      tx.objectStore('snapshot').put(value, 'chrome')
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = tx.onabort = () => {
        db.close()
        reject(tx.error)
      }
    }
  })
}

/** mirrors everything once at startup, then each change the content script reports from chrome.storage */
export function startChromeMigrationMirror(
  bridge: NormalizedBridge,
  pluginManager: PluginManager
): () => void {
  if (bridge.loader !== 'chrome-extension') return () => {}
  const extensionId = runningExtensionId()
  if (!extensionId || extensionId === __TAUT_CHROME_EXTENSION_ID__) {
    return () => {}
  }

  let entries: Record<string, string> | null = null
  // changes during the first read, applied over what it read
  const early = new Map<string, unknown>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let writing = Promise.resolve()

  const write = () => {
    clearTimeout(timer)
    timer = undefined
    if (!entries) return
    const value: ExtensionSnapshot = {
      version: 1,
      at: Date.now(),
      extensionId,
      entries: { ...entries },
    }
    writing = writing
      .then(() => writeSnapshot(value))
      .catch((err) =>
        console.warn('[Taut] Failed to mirror extension storage:', err)
      )
  }

  const apply = (key: unknown, value: unknown) => {
    if (typeof key !== 'string' || !isMirrored(key)) return
    if (!entries) {
      early.set(key, value)
      return
    }
    const kept = mirroredValue(key, value)
    if (kept === null) delete entries[key]
    else entries[key] = kept
    timer ??= setTimeout(write, WRITE_DELAY)
  }

  // the events extension/chrome/content.js posts for chrome.storage.onChanged
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window) return
    const msg = event.data
    if (!msg?.__taut || msg.kind !== 'event') return
    if (msg.name === 'storage.changed') {
      apply(msg.payload?.key, msg.payload?.newValue)
    } else if (msg.name === 'userPlugin.changed') {
      apply(`taut-user-plugin:${msg.payload?.id}`, msg.payload?.code)
    }
  }
  const onHidden = () => {
    if (document.visibilityState === 'hidden' && timer !== undefined) write()
  }

  let stopped = false
  const stop = () => {
    stopped = true
    clearTimeout(timer)
    window.removeEventListener('message', onMessage)
    document.removeEventListener('visibilitychange', onHidden)
  }
  window.addEventListener('message', onMessage)
  document.addEventListener('visibilitychange', onHidden)
  snapshot(bridge, pluginManager).then(
    (read) => {
      if (stopped) return
      entries = read
      for (const [key, value] of early) apply(key, value)
      early.clear()
      write()
    },
    (err) => {
      // changes alone would overwrite a whole snapshot from an earlier session with a partial one
      stop()
      console.warn('[Taut] Failed to mirror extension storage:', err)
    }
  )
  return stop
}
