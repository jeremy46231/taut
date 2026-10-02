// Taut Client: the plugin manager, loads and runs plugins in the page through TautBridge

import {
  type DefaultConfig,
  opt,
  TautPlugin,
  type TautPluginConfig,
  type TautPluginConstructor,
} from '../shared/Plugin'
import type { BlobStore } from '../shared/TautBridge'
import { AccountSwitcher } from './api/accountSwitcher'
import { bindCache } from './api/cache'
import { setStyle } from './api/css'
import { elementsAPIPromise } from './api/elements'
import { menuAPIPromise } from './api/menu'
import { dialogHelpersFor, modalAPIPromise } from './api/modal'
import { announceStorageChange, ScopedStorage } from './api/pluginStorage'
import { preferences } from './api/preferences'
import { deferResizeWork } from './api/resize'
import { bindSharedStore, SharedStore, sharedFrom } from './api/sharedStore'
import { userAPI } from './api/userAPI'
import type { NormalizedBridge } from './bridgeCompat'
import type { ConfigStore } from './configStore'
import { deepEqual } from './helpers'
import {
  defaultEntries,
  isSecret,
  resolveConfig,
  validateDefaultConfig,
} from './pluginConfig'
import { scheduleEnd } from './schedule'
import { blocksAPIPromise } from './slack/blocks'
import { channelsPromise } from './slack/channels'
import {
  addButton,
  addLinkTransform,
  addSendCheck,
  patchInlineMarkup,
} from './slack/composer'
import { ForcedExperiments } from './slack/experiments'
import { filesPromise } from './slack/files'
import { membersPromise } from './slack/members'
import { onMessageSendBlocks } from './slack/messageSend'
import { messagesPromise } from './slack/messages'
import { profile } from './slack/profile'
import {
  getComponent,
  getRenderedComponent,
  lazyComponent,
  patchComponentPromise,
  reactPromise,
  waitForComponent,
  waitForRenderedComponent,
} from './slack/react'
import { reduxPromise } from './slack/redux'
import { rtmPromise } from './slack/rtm'
import {
  byMeta,
  byName,
  findModuleId,
  getByProps,
  getExport,
  getModuleSources,
  waitForExport,
} from './slack/webpack'
import { workspace } from './slack/workspace'
import { Store } from './store'

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

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err)

async function safely<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run()
  } catch {
    return fallback
  }
}

const global = globalThis as any
global.TautPlugin = TautPlugin
global.TautOpt = opt

async function makeBaseTautAPI(bridge: NormalizedBridge) {
  const patchComponent = await patchComponentPromise

  const TautAPI = {
    setStyle,
    byName,
    byMeta,
    waitForExport,
    waitForComponent,
    waitForRenderedComponent,
    lazyComponent,
    getExport,
    getByProps,
    getModuleSources,
    findModuleId,
    getComponent,
    getRenderedComponent,
    patchComponent,
    redux: await reduxPromise,
    experiments: new ForcedExperiments(),
    members: await membersPromise,
    messages: await messagesPromise,
    channels: await channelsPromise,
    blocks: await blocksAPIPromise,
    files: await filesPromise,
    profile,
    rtm: await rtmPromise,
    workspace,
    fetch: bridge.fetch.bind(bridge),
    userAPI,
    cookies: bridge.cookies ?? null,
    accounts: new AccountSwitcher(bridge),
    modal: await modalAPIPromise,
    menu: await menuAPIPromise,
    elements: await elementsAPIPromise,
    preferences,
    commonModules: {
      react: await reactPromise,
    },
    onMessageSendBlocks,
    composer: { patchInlineMarkup, addButton, addSendCheck, addLinkTransform },
    deferResizeWork,
    scheduleEnd,
    Store,
    SharedStore,
    sharedFrom,
  }
  global.TautAPI = TautAPI
  console.log('[Taut] Base TautAPI initialized', TautAPI)
  return TautAPI
}

/** the TautAPI without anything scoped to a running plugin */
export type BaseTautAPI = Awaited<ReturnType<typeof makeBaseTautAPI>>

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

/** a plugin's `this.api`, registrations undone when it stops and storage scoped to its id */
function createScopedAPI(
  base: BaseTautAPI,
  id: string,
  scope: PluginScope,
  storage: { blob: BlobStore; namespace: string },
  cacheBlob: BlobStore
) {
  const tracked = <F extends (...args: any[]) => () => void>(fn: F): F =>
    ((...args: Parameters<F>) => scope.track(fn(...args))) as F
  const experiments = new ForcedExperiments()
  scope.track(experiments.dispose)
  const openModal: typeof base.modal.openModal = (options) => {
    if (scope.signal.aborted) return null
    let open = true
    const closing =
      (callback = () => {}) =>
      () => {
        open = false
        callback()
      }
    const handle = base.modal.openModal({
      ...options,
      onSubmit: closing(options.onSubmit),
      onCancel: closing(options.onCancel),
      onClose: closing(options.onClose),
    })
    if (!handle) return handle
    // closing it when the plugin stops counts as a dismissal
    const dismiss = scope.track(() => {
      handle.close()
      if (open) closing(options.onClose)()
    })
    return { ...handle, close: closing(dismiss) }
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
    experiments,
    rtm: { ...base.rtm, on: tracked(base.rtm.on) },
    workspace: {
      ...base.workspace,
      onChange: tracked(base.workspace.onChange),
    },
    messages: {
      ...base.messages,
      injectMessages: tracked(base.messages.injectMessages),
      patchMessageText: tracked(base.messages.patchMessageText),
      patchActionableMessage: tracked(base.messages.patchActionableMessage),
    },
    onMessageSendBlocks: tracked(base.onMessageSendBlocks),
    composer: {
      ...base.composer,
      patchInlineMarkup: tracked(base.composer.patchInlineMarkup),
      addButton: tracked(base.composer.addButton),
      addSendCheck: tracked(base.composer.addSendCheck),
      addLinkTransform: tracked(base.composer.addLinkTransform),
    },
    deferResizeWork: tracked(base.deferResizeWork),
    setStyle: tracked((css: string | null, key?: string) =>
      base.setStyle(css, key === undefined ? undefined : `plugin:${id}:${key}`)
    ),
    modal: {
      ...base.modal,
      openModal,
      ...dialogHelpersFor(openModal),
    },
    preferences: {
      ...base.preferences,
      addTab: tracked(base.preferences.addTab),
    },
    sharedFrom: <T>(pluginId: string, key: string) => {
      const handle = base.sharedFrom<T>(pluginId, key)
      return { ...handle, subscribe: tracked(handle.subscribe) }
    },
    storage: new ScopedStorage(storage.blob, storage.namespace, scope.signal),
    Cache: bindCache(cacheBlob),
    SharedStore: bindSharedStore(id, scope.signal),
  }
}

type ResolvedConfig = ReturnType<typeof resolveConfig>

type PluginEntry = {
  /** null for a stored user plugin whose code couldn't be loaded */
  PluginClass: TautPluginConstructor | null
  instance: TautPlugin | null
  source: PluginSource
  /** last code this plugin was loaded from, to dedup storage/watcher echoes */
  code: string
  scope: PluginScope | null
  /** why it couldn't be loaded or started */
  error: string | null
  /** its config in the file right now, see `resolveConfig` */
  resolved: ResolvedConfig
  /** the config its runtime was last (re)started for */
  applied: TautPluginConfig | null
  /** new each time it's (re)registered, to remount its data panel */
  runId: number
}

export class PluginManager {
  /** resolves once Slack's modules it's made from have loaded */
  readonly baseAPI: Promise<BaseTautAPI>
  plugins = new Map<string, PluginEntry>()
  readonly pluginInfoStore = new Store<PluginInfo>(this.getPluginInfo())
  /** does each plugin have any stored data / cache */
  readonly pluginDataStore = new Store<Record<string, PluginDataFlags>>({})
  /** serializes lifecycle operations (load, unload, config, reset) per plugin id */
  private pluginQueues = new Map<string, Promise<unknown>>()
  private runCount = 0

  constructor(
    readonly bridge: NormalizedBridge,
    protected configStore: ConfigStore,
    /** register plugins but start none of them, see `consumeSafeMode` */
    readonly safeMode: boolean
  ) {
    this.baseAPI = makeBaseTautAPI(bridge)

    this.configStore.onConfigChange((newConfig) => {
      for (const [name, plugin] of this.plugins) {
        if (!plugin.PluginClass) continue
        plugin.resolved = resolveConfig(
          plugin.PluginClass.defaultConfig,
          newConfig.plugins[name]
        )
        const { config } = plugin.resolved
        this.updatePluginConfig(name, config as TautPluginConfig).catch((err) =>
          console.error(`[Taut] Failed to apply config for ${name}:`, err)
        )
      }
      this.pluginInfoStore.set(this.getPluginInfo())
    })

    workspace.onChange(() => this.applyWorkspace())
  }

  private runsHere(PluginClass: TautPluginConstructor): boolean {
    return PluginClass.hackClubOnly !== true || workspace.isHackClub()
  }

  /** start or stop Hack Club-only plugins after the workspace changes */
  private applyWorkspace() {
    this.pluginInfoStore.set(this.getPluginInfo())
    for (const [id, plugin] of this.plugins) {
      if (plugin.PluginClass?.hackClubOnly !== true) continue
      this.runExclusive(id, async () => {
        const current = this.plugins.get(id)
        if (!current?.PluginClass) return
        const shouldRun =
          current.resolved.config.enabled === true &&
          !this.safeMode &&
          this.runsHere(current.PluginClass)
        if ((current.instance !== null) === shouldRun) return
        await this.registerPlugin(
          id,
          current.PluginClass,
          current.code,
          current.source
        )
      }).catch((err) =>
        console.error(`[Taut] Failed to restart plugin ${id}:`, err)
      )
    }
  }

  get supportsUserPlugins(): boolean {
    return this.bridge.supportsUserPlugins
  }

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
  /** the bridge secret holding one of a plugin's `opt.secret` values */
  private secretName(id: string, key: string): string {
    return `plugin:${id}:${key}`
  }

  /** every loaded plugin's `opt.secret` bridge secrets, set or not */
  pluginSecretNames(): string[] {
    const names: string[] = []
    for (const [id, plugin] of this.plugins) {
      if (!plugin.PluginClass) continue
      for (const entry of defaultEntries(plugin.PluginClass.defaultConfig)) {
        if (isSecret(entry)) names.push(this.secretName(id, entry.key))
      }
    }
    return names
  }

  /** the set `opt.secret` values, with `migrate` one left in config.json moves to secret storage if it can */
  private async readSecrets(
    id: string,
    defaults: DefaultConfig,
    migrate: boolean
  ): Promise<Record<string, string>> {
    const values: Record<string, string> = {}
    for (const entry of defaultEntries(defaults)) {
      if (!isSecret(entry)) continue
      const name = this.secretName(id, entry.key)
      const inFile = this.configStore.getConfig().plugins[id]?.[entry.key]
      if (migrate && typeof inFile === 'string' && inFile !== '') {
        const saved = await safely(
          () => this.bridge.writeSecret(name, inFile),
          false
        )
        if (!saved) {
          console.warn(
            `[Taut] Couldn't move ${id}.${entry.key} to secret storage, reading it from config.json`
          )
          continue
        }
        const path = ['plugins', id, entry.key]
        if (!(await this.configStore.removeConfigValue(path))) {
          console.warn(
            `[Taut] Moved ${id}.${entry.key} to secret storage, but couldn't remove it from config.json`
          )
        }
      }
      const stored = await safely(() => this.bridge.readSecret(name), null)
      if (stored) values[entry.key] = stored
    }
    return values
  }

  async readPluginSecret(id: string, key: string): Promise<string> {
    const stored = await safely(
      () => this.bridge.readSecret(this.secretName(id, key)),
      null
    )
    const inFile = this.configStore.getConfig().plugins[id]?.[key]
    return stored || (typeof inFile === 'string' ? inFile : '')
  }

  async setPluginSecret(
    id: string,
    key: string,
    value: string
  ): Promise<boolean> {
    return this.runExclusive(id, async () => {
      const saved = await safely(
        () => this.bridge.writeSecret(this.secretName(id, key), value),
        false
      )
      if (!saved) return false
      const existing = this.plugins.get(id)
      if (existing?.PluginClass) await this.reregister(id, existing)
      return true
    })
  }

  /** older loaders have no deleteSecret, so the values are blanked there */
  private async clearSecrets(
    id: string,
    defaults: DefaultConfig
  ): Promise<void> {
    const { deleteSecret } = this.bridge
    for (const entry of defaultEntries(defaults)) {
      if (!isSecret(entry)) continue
      const name = this.secretName(id, entry.key)
      await safely(
        () =>
          deleteSecret ? deleteSecret(name) : this.bridge.writeSecret(name, ''),
        false
      )
    }
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
    previous: PluginEntry | undefined
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
        await this.reregister(id, previous)
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

  /** refreshes `pluginDataStore` after each successful mutation */
  private watchedBlobStore(id: string, kind: DataKind, blob: BlobStore) {
    const refresh = () => {
      blob
        .list()
        .then((keys) => this.setPluginDataFlag(id, kind, keys.length > 0))
        .catch(() => {})
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

  private async makeScopedAPI(
    id: string,
    scope: PluginScope
  ): Promise<TautAPI> {
    const base = await this.baseAPI
    return createScopedAPI(
      base,
      id,
      scope,
      {
        blob: this.watchedBlobStore(
          id,
          'storage',
          scope.wrap(this.bridge.blobStore(this.storageNamespace(id)))
        ),
        namespace: this.storageNamespace(id),
      },
      this.watchedBlobStore(
        id,
        'cache',
        scope.wrap(this.bridge.blobStore(this.cacheNamespace(id)))
      )
    )
  }

  /** `code` is a compiled IIFE expression, giving the class or a module with it as `default` */
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
      !/^[A-Za-z0-9_.-]+$/.test(id)
    ) {
      throw new Error(
        `Plugin has an invalid static id "${id}" (allowed: letters, numbers, "_", ".", "-")`
      )
    }

    try {
      validateDefaultConfig(PluginClass.defaultConfig)
    } catch (err) {
      throw new Error(
        `Plugin ${id}: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    return { id, PluginClass }
  }

  /** pluginDataStore's initial value for `id`, from what's on disk */
  private refreshDataFlags(id: string) {
    this.bridge
      .blobStore(this.storageNamespace(id))
      .list()
      .then((keys) => this.setPluginDataFlag(id, 'storage', keys.length > 0))
      .catch(() => {})
    this.bridge
      .blobStore(this.cacheNamespace(id))
      .list()
      .then((keys) => this.setPluginDataFlag(id, 'cache', keys.length > 0))
      .catch(() => {})
  }

  /** a plugin that fails to start stays registered with its error, which is returned */
  private async registerPlugin(
    id: string,
    PluginClass: TautPluginConstructor,
    code: string,
    source: PluginSource
  ): Promise<string | null> {
    // a plugin that can't run here leaves config.json alone
    const secrets = await this.readSecrets(
      id,
      PluginClass.defaultConfig,
      this.runsHere(PluginClass)
    )
    const resolved = resolveConfig(
      PluginClass.defaultConfig,
      this.configStore.getConfig().plugins[id]
    )
    for (const [key, problem] of Object.entries(resolved.problems)) {
      console.warn(`[Taut] ${id}.${key}: ${problem}, using the default`)
    }
    // what later file changes compare to
    const applied = structuredClone(resolved.config) as TautPluginConfig
    const config = { ...resolved.config, ...secrets } as TautPluginConfig

    const runs =
      config.enabled === true && !this.safeMode && this.runsHere(PluginClass)
    const existing = this.plugins.get(id)
    if (existing) {
      await this.stopRuntime(id, existing)
      // a restart leaves its settings panel up until the new one replaces it
      if (!runs) this.pluginInfoStore.set(this.getPluginInfo())
    }

    let instance: TautPlugin | null = null
    let scope: PluginScope | null = null
    let error: string | null = null

    if (runs) {
      // plugins may use JSX
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
        console.error(`[Taut] Plugin ${id} failed to start:`, err)
        error = `Failed to start: ${errorText(err)}`
        await this.stopRuntime(id, { instance, scope })
        instance = null
        scope = null
      }
    }

    this.plugins.set(id, {
      PluginClass,
      instance,
      source,
      code,
      scope,
      error,
      resolved,
      applied,
      runId: ++this.runCount,
    })
    this.pluginInfoStore.set(this.getPluginInfo())
    if (!(id in this.pluginDataStore.get())) this.refreshDataFlags(id)
    console.log(`[Taut] Plugin ${id} loaded`)
    return error
  }

  /** put a plugin back as it was: restarted, or a failed load listed again */
  private async reregister(id: string, entry: PluginEntry): Promise<void> {
    if (entry.PluginClass) {
      await this.registerPlugin(id, entry.PluginClass, entry.code, entry.source)
    } else {
      this.plugins.set(id, entry)
      this.pluginInfoStore.set(this.getPluginInfo())
    }
  }

  private async stopRuntime(
    id: string,
    runtime: Pick<PluginEntry, 'instance' | 'scope'>
  ): Promise<void> {
    // abort before giving stop a chance to release non-TautAPI resources
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
  ): Promise<string | null> {
    const existing = this.plugins.get(id)
    if (existing && existing.source !== source) {
      const error = `A ${existing.source === 'bundled' ? 'built-in' : existing.source} plugin already uses the id "${id}"`
      console.error(`[Taut] Refusing to load ${source} plugin: ${error}`)
      return error
    }
    if (existing && existing.code === code) return existing.error

    if (existing) await this.stopRuntime(id, existing)
    let storageSnapshot: Map<string, string>
    try {
      storageSnapshot = await this.snapshotBlobStore(
        this.bridge.blobStore(this.storageNamespace(id))
      )
    } catch (err) {
      console.error(`[Taut] Failed to back up plugin ${id} data:`, err)
      if (existing) await this.reregister(id, existing)
      return `Failed to back up its data: ${errorText(err)}`
    }

    const error = await this.registerPlugin(id, PluginClass, code, source)
    // a built-in plugin has nothing to roll back to and stays listed with its error
    if (error && source === 'user' && existing?.PluginClass) {
      if (!(await this.restoreRuntimeState(id, storageSnapshot, existing)))
        console.error(`[Taut] Plugin ${id} rollback was incomplete`)
    }
    return error
  }

  /** show why a plugin couldn't be loaded, listing it if it wasn't */
  private setError(id: string, error: string, code = '') {
    const existing = this.plugins.get(id)
    this.plugins.set(
      id,
      existing
        ? { ...existing, error }
        : {
            PluginClass: null,
            instance: null,
            source: 'user',
            code,
            scope: null,
            error,
            resolved: { config: {}, problems: {} },
            applied: null,
            runId: 0,
          }
    )
    this.pluginInfoStore.set(this.getPluginInfo())
  }

  async loadPluginCode(code: string, source: PluginSource): Promise<boolean> {
    let id: string
    let PluginClass: TautPluginConstructor
    try {
      ;({ id, PluginClass } = await this.prepareCode(code))
    } catch (err) {
      console.error('[Taut] Failed to load plugin:', err)
      return false
    }
    return this.runExclusive(
      id,
      async () =>
        (await this.loadPreparedPlugin(id, PluginClass, code, source)) === null
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
        this.setError(id, errorText(err).replace(`Plugin ${id}: `, ''), code)
        return false
      }

      if (prepared.id !== id) {
        const error = `Stored as "${id}" but declares the id "${prepared.id}"`
        console.error(`[Taut] ${error}; skipping.`)
        this.setError(id, error, code)
        return false
      }
      const error = await this.loadPreparedPlugin(
        id,
        prepared.PluginClass,
        code,
        'user'
      )
      if (error) this.setError(id, error, code)
      return error === null
    })
  }

  async updatePluginConfig(name: string, newConfig: TautPluginConfig) {
    return this.runExclusive(name, async () => {
      const existing = this.plugins.get(name)
      if (!existing?.PluginClass || deepEqual(existing.applied, newConfig))
        return
      console.log(`[Taut] Updating config for plugin: ${name}`)

      const wasEnabled = existing.instance !== null
      await this.stopRuntime(name, existing)

      // disabling drops the cache (it regenerates) but keeps storage, deleteUserPlugin drops both
      if (wasEnabled && !newConfig.enabled) {
        const cleared = await this.bridge
          .blobStore(this.cacheNamespace(name))
          .clear()
          .catch(() => false)
        if (cleared) {
          this.setPluginDataFlag(name, 'cache', false)
        }
      }

      // this records the config it reads, which may be newer than `newConfig`
      await this.registerPlugin(
        name,
        existing.PluginClass,
        existing.code,
        existing.source
      )
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
      const existing = this.plugins.get(id)
      if (existing && (existing.source === 'bundled' || id !== replacingId)) {
        return {
          ok: false,
          error:
            existing.source === 'user'
              ? `A user plugin with id "${id}" already exists. Use its "Update code" button to replace it.`
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
        if (existing) await this.reregister(id, existing)
        return {
          ok: false,
          error: `Failed to back up plugin data: ${err instanceof Error ? err.message : String(err)}`,
        }
      }

      const error = await this.registerPlugin(id, PluginClass, code, 'user')
      if (error) {
        await this.restoreRuntimeState(id, storageSnapshot, existing)
        return { ok: false, error }
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
        await this.reregister(id, existing)
        return {
          ok: false,
          error: `Failed to back up plugin data: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      let deleted: boolean
      try {
        deleted = await store.delete(id)
      } catch (err) {
        await this.reregister(id, existing)
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
      if (!deleted) {
        await this.reregister(id, existing)
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
        if (restored) await this.reregister(id, existing)
        return { ok: false, error: 'Failed to clear all plugin data' }
      }
      if (existing.PluginClass) {
        await this.clearSecrets(id, existing.PluginClass.defaultConfig)
      }
      if (!(await this.configStore.removeConfigValue(['plugins', id]))) {
        console.warn(
          `[Taut] Deleted plugin ${id}, but couldn't remove its settings from config.json`
        )
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

      // other tabs keep running, so their stores go back to the fallback
      if (kind === 'storage') announceStorageChange(this.storageNamespace(id))
      await this.reregister(id, existing)
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
      .map(
        ([id, { PluginClass, instance, source, error, resolved, runId }]) => ({
          id,
          name: PluginClass?.pluginName ?? id,
          description: PluginClass?.description ?? '',
          authors: PluginClass?.authors ?? [],
          category:
            typeof PluginClass?.category === 'string'
              ? PluginClass.category
              : undefined,
          hackClubOnly: PluginClass?.hackClubOnly === true,
          runsHere: !PluginClass || this.runsHere(PluginClass),
          /** null for a user plugin whose code couldn't be loaded */
          defaultConfig: PluginClass?.defaultConfig ?? null,
          /** its config in the file, with what fell back to the default and why */
          config: resolved.config,
          problems: resolved.problems,
          running: instance !== null,
          isUser: source === 'user',
          error,
          hasDataPanel: typeof PluginClass?.prototype.dataPanel === 'function',
          /** its data's UI on its settings page, while it's running */
          dataPanel: instance?.dataPanel?.bind(instance),
          runId,
        })
      )
  }
}
export type PluginInfo = ReturnType<PluginManager['getPluginInfo']>
