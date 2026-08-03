// Taut Client (the plugin manager)
// Runs in the browser page context
// Loads and manages plugins via TautBridge

import {
  TautPlugin,
  type TautPluginConfig,
  type TautPluginConstructor,
} from '../shared/Plugin'
import type { BlobStore, TautBridge } from '../shared/TautBridge'
import { AccountSwitcher } from './api/accountSwitcher'
import { bindCache } from './api/cache'
import { removeStyle, setStyle } from './api/css'
import { elementsAPIPromise } from './api/elements'
import { setupMessageSendDelta } from './api/messageSend'
import { dialogHelpersFor, modalAPIPromise } from './api/modal'
import { ScopedStorage } from './api/pluginStorage'
import { Store } from './api/store'
import { userAPI } from './api/userAPI'
import type { NormalizedBridge } from './bridgeCompat'
import { initJsonc } from './cdn'
import type { ConfigStore } from './configStore'
import { deepEqual } from './helpers'
import { channelsPromise } from './slack/channels'
import { membersPromise } from './slack/members'
import {
  findComponentPromise,
  patchComponentPromise,
  reactPromise,
} from './slack/react'
import { reduxPromise } from './slack/redux'
import { findByPropsPromise, findExportPromise } from './slack/webpack'

const PLUGIN_ID_RE = /^[A-Za-z0-9_.-]+$/
const PLUGIN_LIFECYCLE_TIMEOUT_MS = 5_000

function withLifecycleTimeout<T>(
  id: string,
  phase: 'start' | 'stop',
  operation: Promise<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`Plugin ${id} ${phase} timed out after 5 seconds`)),
      PLUGIN_LIFECYCLE_TIMEOUT_MS
    )
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

const global = globalThis as any
global.TautPlugin = TautPlugin

async function makeBaseTautAPI(bridge: TautBridge) {
  const patchComponent = await patchComponentPromise

  const TautAPI = {
    setStyle,
    removeStyle,
    findExport: await findExportPromise,
    findByProps: await findByPropsPromise,
    findComponent: await findComponentPromise,
    patchComponent,
    redux: await reduxPromise,
    members: await membersPromise,
    channels: await channelsPromise,
    fetch: bridge.fetch.bind(bridge),
    userAPI,
    cookies: bridge.cookies ?? null,
    accounts: new AccountSwitcher(bridge),
    modal: await modalAPIPromise,
    elements: await elementsAPIPromise,
    commonModules: {
      react: await reactPromise,
    },
    onMessageSendDelta: setupMessageSendDelta(patchComponent),
    Store,
  }
  global.TautAPI = TautAPI
  console.log('[Taut] Base TautAPI initialized', TautAPI)
  return TautAPI
}

type BaseTautAPI = Awaited<ReturnType<typeof makeBaseTautAPI>>

export type TautAPI = ReturnType<typeof createScopedAPI>

type PluginSource = 'bundled' | 'user'
type DataKind = 'storage' | 'cache'
export type PluginDataFlags = { hasStorage: boolean; hasCache: boolean }

type PluginScope = {
  signal: AbortSignal
  abort(): void
  track(cleanup: () => void): () => void
  wrap(blob: BlobStore): BlobStore
  dispose(): Promise<void>
}

function createPluginScope(): PluginScope {
  let active = true
  let mutationTail: Promise<void> = Promise.resolve()
  const controller = new AbortController()
  const pending = new Set<Promise<unknown>>()
  const cleanups: Array<() => void> = []
  const track = (cleanup: () => void) => {
    let cleaned = false
    const wrapped = () => {
      if (cleaned) return
      cleaned = true
      cleanup()
    }
    if (active) cleanups.push(wrapped)
    else wrapped()
    return wrapped
  }
  const mutation = <T>(run: () => Promise<T>, rejected: T): Promise<T> => {
    if (!active) return Promise.resolve(rejected)
    const promise = mutationTail.then(run)
    mutationTail = promise.then(
      () => {},
      () => {}
    )
    pending.add(promise)
    promise.finally(() => pending.delete(promise)).catch(() => {})
    return promise
  }
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    track,
    wrap: (blob) => ({
      list: () => blob.list(),
      read: (key) => blob.read(key),
      write: (key, value) => mutation(() => blob.write(key, value), false),
      delete: (key) => mutation(() => blob.delete(key), false),
      clear: () => mutation(() => blob.clear(), false),
    }),
    async dispose() {
      if (!active) return
      active = false
      controller.abort()
      for (let i = cleanups.length - 1; i >= 0; i--) {
        try {
          cleanups[i]()
        } catch (err) {
          console.error('[Taut] Error disposing plugin resource:', err)
        }
      }
      await Promise.allSettled([...pending])
    },
  }
}

/**
 * build this.api for a plugin, things scoped and wrapped for it
 */
function createScopedAPI(
  base: BaseTautAPI,
  id: string,
  scope: PluginScope,
  storageBlob: BlobStore,
  cacheBlob: BlobStore
) {
  const scopedStyleKey = (key: string) => `${id.length}-${id}-${key}`
  const trackedStyleKeys = new Set<string>()
  // Wrap a registration fn so the disposer it returns is auto-run on teardown.
  const tracked = <F extends (...args: any[]) => () => void>(fn: F): F =>
    ((...args: Parameters<F>) => scope.track(fn(...args))) as F
  const openModal: typeof base.modal.openModal = (...args) => {
    if (scope.signal.aborted) return null
    const handle = base.modal.openModal(...args)
    if (!handle) return handle
    const close = scope.track(handle.close)
    return { ...handle, close }
  }
  return {
    ...base,
    signal: scope.signal,
    patchComponent: tracked(base.patchComponent) as typeof base.patchComponent,
    redux: {
      ...base.redux,
      patchState: tracked(base.redux.patchState),
      patchSlice: tracked(base.redux.patchSlice),
      patchThunk: tracked(base.redux.patchThunk),
    },
    onMessageSendDelta: tracked(base.onMessageSendDelta),
    setStyle: (key: string, css: string) => {
      if (scope.signal.aborted) return
      const scopedKey = scopedStyleKey(key)
      base.setStyle(scopedKey, css)
      if (!trackedStyleKeys.has(scopedKey)) {
        trackedStyleKeys.add(scopedKey)
        scope.track(() => base.removeStyle(scopedKey))
      }
    },
    removeStyle: (key: string) => {
      if (!scope.signal.aborted) base.removeStyle(scopedStyleKey(key))
    },
    modal: {
      ...base.modal,
      openModal,
      ...dialogHelpersFor(openModal),
    },
    storage: new ScopedStorage(storageBlob),
    Cache: bindCache(cacheBlob),
  }
}

export class PluginManager {
  private readonly baseAPIPromise: Promise<BaseTautAPI>
  plugins = new Map<
    string,
    {
      PluginClass: TautPluginConstructor
      instance: TautPlugin | null
      source: PluginSource
      /** last code this plugin was loaded from, to dedup storage/watcher echoes */
      code: string
      scope: PluginScope | null
    }
  >()
  readonly pluginInfoStore = new Store<PluginInfo>(this.getPluginInfo())
  /** does each plugin have any stored data / cache */
  readonly pluginDataStore = new Store<Record<string, PluginDataFlags>>({})
  private prevPluginConfigs = new Map<string, TautPluginConfig>()
  /** Serializes lifecycle operations (load/unload/config/reset) per plugin id. */
  private pluginQueues = new Map<string, Promise<unknown>>()

  constructor(
    protected bridge: NormalizedBridge,
    protected configStore: ConfigStore
  ) {
    this.baseAPIPromise = makeBaseTautAPI(bridge)

    this.configStore.onConfigChange((newConfig) => {
      for (const [name, pluginConfig] of Object.entries(newConfig.plugins)) {
        if (deepEqual(this.prevPluginConfigs.get(name), pluginConfig)) continue
        this.updatePluginConfig(name, pluginConfig).catch((err) =>
          console.error(`[Taut] Failed to apply config for ${name}:`, err)
        )
      }
    })
  }

  get supportsUserPlugins(): boolean {
    return this.bridge.supportsUserPlugins
  }

  /** Run `task` after any prior queued operation on this plugin id finishes. */
  private runExclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prev = (this.pluginQueues.get(id) ?? Promise.resolve()).catch(
      () => {}
    )
    const result = prev.then(task)
    this.pluginQueues.set(
      id,
      result.then(
        () => {},
        () => {}
      )
    )
    return result
  }

  private storageNamespace(id: string): string {
    return `plugin:${id}:storage`
  }
  private cacheNamespace(id: string): string {
    return `plugin:${id}:cache`
  }

  private async snapshotBlobStore(
    blob: BlobStore
  ): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>()
    for (const key of await blob.list()) {
      const value = await blob.read(key)
      if (value !== null) snapshot.set(key, value)
    }
    return snapshot
  }

  private async restoreBlobStore(
    blob: BlobStore,
    snapshot: Map<string, string>
  ): Promise<boolean> {
    if (!(await blob.clear().catch(() => false))) return false
    for (const [key, value] of snapshot) {
      if (!(await blob.write(key, value).catch(() => false))) return false
    }
    return true
  }

  private async restoreRuntimeState(
    id: string,
    snapshot: Map<string, string>,
    previous:
      | (typeof this.plugins extends Map<string, infer R> ? R : never)
      | undefined
  ): Promise<boolean> {
    const current = this.plugins.get(id)
    if (current && current !== previous) await this.stopRuntime(id, current)

    const cacheCleared = await this.bridge
      .blobStore(this.cacheNamespace(id))
      .clear()
      .catch(() => false)
    const storageRestored = await this.restoreBlobStore(
      this.bridge.blobStore(this.storageNamespace(id)),
      snapshot
    )

    try {
      if (previous) {
        await this.registerPlugin(
          id,
          previous.PluginClass,
          previous.code,
          previous.source
        )
      } else {
        await this.unloadPluginRaw(id)
      }
    } catch (err) {
      console.error(`[Taut] Failed to restore plugin ${id}:`, err)
      return false
    }
    return cacheCleared && storageRestored
  }

  private setPluginDataFlag(id: string, kind: DataKind, value: boolean) {
    this.pluginDataStore.update((prev) => {
      const cur = prev[id] ?? { hasStorage: false, hasCache: false }
      const key = kind === 'storage' ? 'hasStorage' : 'hasCache'
      if (cur[key] === value) return prev
      return { ...prev, [id]: { ...cur, [key]: value } }
    })
  }

  private forgetPluginDataFlags(id: string) {
    this.pluginDataStore.update((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  /**
   * Wrap a BlobStore so every successful mutation refreshes `pluginDataStore`
   */
  private watchedBlobStore(id: string, kind: DataKind, blob: BlobStore) {
    const refresh = () => {
      blob
        .list()
        .then((keys) => this.setPluginDataFlag(id, kind, keys.length > 0))
    }
    const watched: BlobStore = {
      list: () => blob.list(),
      read: (key) => blob.read(key),
      write: async (key, value) => {
        const ok = await blob.write(key, value)
        if (ok) refresh()
        return ok
      },
      delete: async (key) => {
        const ok = await blob.delete(key)
        if (ok) refresh()
        return ok
      },
      clear: async () => {
        const ok = await blob.clear()
        if (ok) this.setPluginDataFlag(id, kind, false)
        return ok
      },
    }
    return watched
  }

  /** Build the per-plugin API: shared base plus storage/Cache scoped to `id`. */
  private async makeScopedAPI(
    id: string,
    scope: PluginScope
  ): Promise<TautAPI> {
    const base = await this.baseAPIPromise
    return createScopedAPI(
      base,
      id,
      scope,
      this.watchedBlobStore(
        id,
        'storage',
        scope.wrap(this.bridge.blobStore(this.storageNamespace(id)))
      ),
      this.watchedBlobStore(
        id,
        'cache',
        scope.wrap(this.bridge.blobStore(this.cacheNamespace(id)))
      )
    )
  }

  /** Evaluate compiled plugin IIFE code into its TautPlugin subclass. */
  private evalPluginClass(code: string): TautPluginConstructor {
    const result = new Function(`return ${code}`)()
    const PluginClass =
      result?.prototype instanceof TautPlugin
        ? (result as TautPluginConstructor)
        : (result?.default as TautPluginConstructor)

    if (
      typeof PluginClass !== 'function' ||
      !(PluginClass.prototype instanceof TautPlugin)
    ) {
      throw new Error('Plugin class does not extend TautPlugin')
    }
    return PluginClass
  }

  /**
   * Evaluate plugin code (once) and validate its static `id`
   */
  private async prepareCode(
    code: string
  ): Promise<{ id: string; PluginClass: TautPluginConstructor }> {
    const PluginClass = this.evalPluginClass(code)
    const id = PluginClass.id
    if (
      typeof id !== 'string' ||
      id === '.' ||
      id === '..' ||
      id.length === 0 ||
      id.length > 100 ||
      !PLUGIN_ID_RE.test(id)
    ) {
      throw new Error(
        `Plugin has an invalid static id "${id}" (allowed: letters, numbers, "_", ".", "-")`
      )
    }

    const snippet = PluginClass.defaultConfig
    if (typeof snippet === 'string' && snippet.trim()) {
      const jsonc = await initJsonc()
      let parsed: unknown = null
      try {
        parsed = jsonc.parse(`{${snippet}}`, undefined, {
          allowTrailingComma: true,
        })
      } catch {
        parsed = null
      }
      const configKey =
        parsed && typeof parsed === 'object'
          ? Object.keys(parsed as Record<string, unknown>)[0]
          : undefined
      if (configKey !== id) {
        throw new Error(
          `Plugin id "${id}" does not match its defaultConfig key "${configKey ?? '(none)'}"`
        )
      }
    }

    return { id, PluginClass }
  }

  /** Populate pluginDataStore's initial value for `id` from what's on disk */
  private refreshDataFlags(id: string) {
    this.bridge
      .blobStore(this.storageNamespace(id))
      .list()
      .then((keys) => this.setPluginDataFlag(id, 'storage', keys.length > 0))
    this.bridge
      .blobStore(this.cacheNamespace(id))
      .list()
      .then((keys) => this.setPluginDataFlag(id, 'cache', keys.length > 0))
  }

  /** Ensure config, (re)instantiate if enabled, and register the plugin */
  private async registerPlugin(
    id: string,
    PluginClass: TautPluginConstructor,
    code: string,
    source: PluginSource
  ): Promise<void> {
    await this.configStore.ensurePluginConfig(id, PluginClass.defaultConfig)
    const config = this.configStore.getConfig().plugins[id] ?? {
      enabled: false,
    }

    const existing = this.plugins.get(id)
    if (existing) {
      await this.stopRuntime(id, existing)
      this.pluginInfoStore.set(this.getPluginInfo())
    }

    let instance: TautPlugin | null = null
    let scope: PluginScope | null = null

    if (config.enabled) {
      // Wait for React before instantiating plugins (they may use JSX)
      await reactPromise

      scope = createPluginScope()
      try {
        const api = await this.makeScopedAPI(id, scope)
        instance = new PluginClass(api, config)
        await withLifecycleTimeout(
          id,
          'start',
          Promise.resolve(instance.start())
        )
        console.log(`[Taut] Plugin ${id} started successfully`)
      } catch (err) {
        scope.abort()
        if (instance) {
          try {
            await withLifecycleTimeout(
              id,
              'stop',
              Promise.resolve(instance.stop())
            )
          } catch (stopErr) {
            console.error(`[Taut] Error cleaning up plugin ${id}:`, stopErr)
          }
        }
        await scope.dispose()
        throw err
      }
    }

    this.prevPluginConfigs.set(id, structuredClone(config))
    this.plugins.set(id, { PluginClass, instance, source, code, scope })
    this.pluginInfoStore.set(this.getPluginInfo())
    if (!(id in this.pluginDataStore.get())) this.refreshDataFlags(id)
    console.log(`[Taut] Plugin ${id} loaded`)
  }

  private async stopRuntime(
    id: string,
    runtime: typeof this.plugins extends Map<string, infer R> ? R : never
  ): Promise<void> {
    // Abort before giving stop a chance to release non-TautAPI resources
    runtime.scope?.abort()
    try {
      if (runtime.instance)
        await withLifecycleTimeout(
          id,
          'stop',
          Promise.resolve(runtime.instance.stop())
        )
    } catch (err) {
      console.error(`[Taut] Error stopping plugin ${id}:`, err)
    } finally {
      await runtime.scope?.dispose()
      runtime.instance = null
      runtime.scope = null
    }
  }

  private async loadPreparedPlugin(
    id: string,
    PluginClass: TautPluginConstructor,
    code: string,
    source: PluginSource
  ): Promise<boolean> {
    const existing = this.plugins.get(id)
    if (existing && existing.source !== source) {
      console.error(
        `[Taut] Refusing to load ${source} plugin "${id}": a ${existing.source} plugin already uses that id`
      )
      return false
    }
    if (existing && existing.code === code) return true

    if (existing) await this.stopRuntime(id, existing)
    let storageSnapshot: Map<string, string>
    try {
      storageSnapshot = await this.snapshotBlobStore(
        this.bridge.blobStore(this.storageNamespace(id))
      )
    } catch (err) {
      console.error(`[Taut] Failed to back up plugin ${id} data:`, err)
      if (existing) {
        try {
          await this.registerPlugin(
            id,
            existing.PluginClass,
            existing.code,
            existing.source
          )
        } catch (restoreErr) {
          console.error(`[Taut] Failed to restart plugin ${id}:`, restoreErr)
        }
      }
      return false
    }

    try {
      await this.registerPlugin(id, PluginClass, code, source)
      return true
    } catch (err) {
      console.error(`[Taut] Plugin ${id} failed to load:`, err)
      if (!(await this.restoreRuntimeState(id, storageSnapshot, existing)))
        console.error(`[Taut] Plugin ${id} rollback was incomplete`)
      return false
    }
  }

  async loadPluginCode(
    code: string,
    source: PluginSource,
    expectedId?: string
  ): Promise<boolean> {
    let id: string
    let PluginClass: TautPluginConstructor
    try {
      ;({ id, PluginClass } = await this.prepareCode(code))
    } catch (err) {
      console.error('[Taut] Failed to load plugin:', err)
      return false
    }

    if (expectedId !== undefined && id !== expectedId) {
      console.error(
        `[Taut] Plugin stored as "${expectedId}" declares a different id ("${id}"); skipping. Rename it or fix the plugin's static id.`
      )
      return false
    }

    return this.runExclusive(id, () =>
      this.loadPreparedPlugin(id, PluginClass, code, source)
    )
  }

  async applyUserPluginChange(
    id: string,
    code: string | null
  ): Promise<boolean> {
    return this.runExclusive(id, async () => {
      if (code === null) {
        await this.unloadPluginRaw(id)
        return true
      }

      let prepared: { id: string; PluginClass: TautPluginConstructor }
      try {
        prepared = await this.prepareCode(code)
      } catch (err) {
        console.error(`[Taut] Failed to load user plugin ${id}:`, err)
        return false
      }

      if (prepared.id !== id) {
        console.error(
          `[Taut] Plugin stored as "${id}" declares a different id ("${prepared.id}"); skipping.`
        )
        return false
      }
      return this.loadPreparedPlugin(id, prepared.PluginClass, code, 'user')
    })
  }

  async updatePluginConfig(name: string, newConfig: TautPluginConfig) {
    return this.runExclusive(name, async () => {
      if (deepEqual(this.prevPluginConfigs.get(name), newConfig)) return
      console.log(`[Taut] Updating config for plugin: ${name}`)

      const existing = this.plugins.get(name)
      if (!existing) {
        console.warn(`[Taut] Plugin ${name} not loaded, cannot update config`)
        return
      }

      const wasEnabled = existing.instance !== null
      await this.stopRuntime(name, existing)

      // Disabling a plugin drops its cache (regenerable) but keeps its
      // durable storage; deleting a plugin drops both (see deleteUserPlugin)
      if (wasEnabled && !newConfig.enabled) {
        if (await this.bridge.blobStore(this.cacheNamespace(name)).clear()) {
          this.setPluginDataFlag(name, 'cache', false)
        }
      }

      await this.registerPlugin(
        name,
        existing.PluginClass,
        existing.code,
        existing.source
      )
      this.prevPluginConfigs.set(name, structuredClone(newConfig))
      console.log(`[Taut] Plugin ${name} config updated`)
    })
  }

  async installUserPlugin(
    code: string,
    replacingId?: string
  ): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const store = this.bridge.userPlugins
    let id: string
    let PluginClass: TautPluginConstructor
    try {
      ;({ id, PluginClass } = await this.prepareCode(code))
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }

    if (replacingId !== undefined && replacingId !== id) {
      return {
        ok: false,
        error: `Edited plugin must keep id "${replacingId}" (received "${id}")`,
      }
    }

    return this.runExclusive(id, async () => {
      // Collision: the id is already taken by a different plugin
      const existing = this.plugins.get(id)
      if (existing && (existing.source === 'bundled' || id !== replacingId)) {
        return {
          ok: false,
          error:
            existing.source === 'user'
              ? `A user plugin with id "${id}" already exists. Use its Edit button to replace it.`
              : `A built-in plugin already uses the id "${id}". Change your plugin's static id.`,
        }
      }

      if (existing) await this.stopRuntime(id, existing)
      let storageSnapshot: Map<string, string>
      try {
        storageSnapshot = await this.snapshotBlobStore(
          this.bridge.blobStore(this.storageNamespace(id))
        )
      } catch (err) {
        if (existing)
          await this.registerPlugin(
            id,
            existing.PluginClass,
            existing.code,
            existing.source
          ).catch((restoreErr) =>
            console.error(`[Taut] Failed to restart plugin ${id}:`, restoreErr)
          )
        return {
          ok: false,
          error: `Failed to back up plugin data: ${err instanceof Error ? err.message : String(err)}`,
        }
      }

      try {
        await this.registerPlugin(id, PluginClass, code, 'user')
      } catch (err) {
        await this.restoreRuntimeState(id, storageSnapshot, existing)
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
      let persisted = false
      try {
        persisted = await store.write(id, code)
      } catch (err) {
        console.error(`[Taut] Failed to persist plugin ${id}:`, err)
      }
      if (!persisted) {
        const codeRestored = existing
          ? await store.write(id, existing.code).catch(() => false)
          : await store.delete(id).catch(() => false)
        const runtimeRestored = await this.restoreRuntimeState(
          id,
          storageSnapshot,
          existing
        )
        return {
          ok: false,
          error:
            codeRestored && runtimeRestored
              ? 'Failed to save plugin to storage'
              : 'Failed to save plugin and rollback was incomplete',
        }
      }
      return { ok: true, id }
    })
  }

  async deleteUserPlugin(
    id: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const store = this.bridge.userPlugins
    return this.runExclusive(id, async () => {
      const existing = this.plugins.get(id)
      if (existing?.source !== 'user') {
        return { ok: false, error: 'User plugin not loaded' }
      }
      await this.stopRuntime(id, existing)
      const storageBlob = this.bridge.blobStore(this.storageNamespace(id))
      let storageSnapshot: Map<string, string>
      try {
        storageSnapshot = await this.snapshotBlobStore(storageBlob)
      } catch (err) {
        await this.registerPlugin(
          id,
          existing.PluginClass,
          existing.code,
          existing.source
        ).catch((restoreErr) =>
          console.error(`[Taut] Failed to restart plugin ${id}:`, restoreErr)
        )
        return {
          ok: false,
          error: `Failed to back up plugin data: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      let deleted: boolean
      try {
        deleted = await store.delete(id)
      } catch (err) {
        await this.registerPlugin(
          id,
          existing.PluginClass,
          existing.code,
          existing.source
        )
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
      if (!deleted) {
        await this.registerPlugin(
          id,
          existing.PluginClass,
          existing.code,
          existing.source
        )
        return { ok: false, error: 'Failed to delete plugin from storage' }
      }
      const cacheCleared = await this.bridge
        .blobStore(this.cacheNamespace(id))
        .clear()
        .catch(() => false)
      let storageClearAttempted = false
      let storageCleared = false
      if (cacheCleared) {
        storageClearAttempted = true
        storageCleared = await storageBlob.clear().catch(() => false)
      }
      if (!cacheCleared || !storageCleared) {
        if (storageClearAttempted && !storageCleared) {
          const restoredData = await this.restoreBlobStore(
            storageBlob,
            storageSnapshot
          )
          if (!restoredData)
            console.error(`[Taut] Failed to restore plugin ${id} storage`)
        }
        const restored = await store.write(id, existing.code).catch(() => false)
        if (restored) {
          try {
            await this.registerPlugin(
              id,
              existing.PluginClass,
              existing.code,
              existing.source
            )
          } catch (err) {
            console.error(`[Taut] Failed to restart plugin ${id}:`, err)
          }
        }
        return { ok: false, error: 'Failed to clear all plugin data' }
      }
      await this.unloadPluginRaw(id)
      this.forgetPluginDataFlags(id)
      return { ok: true }
    })
  }

  private async unloadPluginRaw(id: string): Promise<void> {
    const existing = this.plugins.get(id)
    if (existing) await this.stopRuntime(id, existing)
    this.plugins.delete(id)
    this.prevPluginConfigs.delete(id)
    this.pluginInfoStore.set(this.getPluginInfo())
    console.log(`[Taut] Plugin ${id} unloaded`)
  }

  async unloadPlugin(id: string): Promise<void> {
    return this.runExclusive(id, () => this.unloadPluginRaw(id))
  }

  async resetPluginNamespace(
    id: string,
    kind: DataKind
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.runExclusive(id, async () => {
      const existing = this.plugins.get(id)
      if (!existing) return { ok: false, error: 'Plugin not loaded' }

      await this.stopRuntime(id, existing)
      this.plugins.set(id, { ...existing, instance: null })
      this.pluginInfoStore.set(this.getPluginInfo())

      const kindsToClear: DataKind[] =
        kind === 'storage' ? ['storage', 'cache'] : ['cache']
      const results = await Promise.all(
        kindsToClear.map(async (k) => {
          const namespace =
            k === 'storage'
              ? this.storageNamespace(id)
              : this.cacheNamespace(id)
          const ok = await this.bridge
            .blobStore(namespace)
            .clear()
            .catch(() => false)
          if (ok) this.setPluginDataFlag(id, k, false)
          return ok
        })
      )

      try {
        await this.registerPlugin(
          id,
          existing.PluginClass,
          existing.code,
          existing.source
        )
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }

      return results.every(Boolean)
        ? { ok: true }
        : { ok: false, error: `Failed to clear plugin ${kind}` }
    })
  }

  getPluginInfo() {
    return [...this.plugins.entries()]
      .sort(([a], [b]) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' })
      )
      .map(([id, plugin]) => ({
        id,
        name: plugin.PluginClass.pluginName,
        description: plugin.PluginClass.description,
        authors: plugin.PluginClass.authors,
        enabled: plugin.instance !== null,
        isUser: plugin.source === 'user',
      }))
  }
}
export type PluginInfo = ReturnType<PluginManager['getPluginInfo']>
