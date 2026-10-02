import type { JsonValue, Widen } from '../../shared/Plugin'
import type { BlobStore } from '../../shared/TautBridge'
import { Store } from '../store'

/** a saved value as a `Store`, synced with storage and with other open Slack tabs */
export type StoredStore<T extends JsonValue> = Pick<
  Store<T>,
  'get' | 'subscribe' | 'use'
> & {
  /** resolves once the saved value is loaded (a failed load is logged and keeps the default) */
  ready: Promise<void>
  /** sets `value` locally immediately, saves it, then resolves with what is now saved */
  set(value: T): Promise<T>
  /** applies `change` locally immediately, then to the saved value with a lock (so no side effects) */
  update(change: (value: T) => T): Promise<T>
  /** ensures the store has the latest saved value */
  refresh(): Promise<T>
}

const channelName = (namespace: string) => `taut:${namespace}`

/** notifies every tab's open stores that `key` (or every key, if omitted) in blob `namespace` changed */
export function announceStorageChange(namespace: string, key?: string) {
  const channel = new BroadcastChannel(channelName(namespace))
  channel.postMessage({ key })
  channel.close()
}

export class ScopedStorage {
  private stores = new Map<string, StoredStore<JsonValue>>()
  private channel: BroadcastChannel | null = null

  constructor(
    private blob: BlobStore,
    /** the blob store's name, like `plugin:<id>:storage` */
    private namespace: string,
    /** closes the channel when it aborts */
    private signal?: AbortSignal
  ) {}

  /** returns the store for `key`, the same one on each call, holding `defaultValue` while nothing is saved */
  store<T extends JsonValue>(
    key: string,
    defaultValue: T
  ): StoredStore<Widen<T>> {
    const store =
      (this.stores.get(key) as StoredStore<Widen<T>> | undefined) ??
      this.open<Widen<T>>(key, defaultValue as Widen<T>)
    this.stores.set(key, store)
    return store
  }

  /** @deprecated use `store(key, defaultValue)` */
  async get<T>(key: string, fallback: T): Promise<T> {
    return this.read(key, fallback as JsonValue) as Promise<T>
  }

  /** @deprecated use `store(key, defaultValue).set(value)` */
  async set<T>(key: string, value: T): Promise<boolean> {
    try {
      await this.write(key, value, () => value)
      return true
    } catch {
      return false
    }
  }

  /** @deprecated use `store(key, defaultValue).update(change)` */
  update<T>(key: string, fallback: T, change: (current: T) => T): Promise<T> {
    return this.write(key, fallback, change)
  }

  /** @deprecated use `store(key, null)` and check for null */
  keys(): Promise<string[]> {
    return this.blob.list()
  }

  /** @deprecated use `delete(key)` */
  async clear(): Promise<boolean> {
    const cleared = await this.blob.clear()
    if (cleared) {
      for (const store of this.stores.values()) await store.refresh()
      this.broadcast()
    }
    return cleared
  }

  /** applies `change` to the saved value under the key's lock, then refreshes every tab's store */
  private async write<T>(
    key: string,
    fallback: T,
    change: (current: T) => T
  ): Promise<T> {
    const next = await navigator.locks.request(this.lockName(key), async () => {
      const value = change((await this.read(key, fallback as JsonValue)) as T)
      if (!(await this.blob.write(key, JSON.stringify(value)))) {
        throw new Error(`Couldn't save ${key}`)
      }
      return value
    })
    await this.stores.get(key)?.refresh()
    this.broadcast(key)
    return next
  }

  /** removes the saved value and resets every tab's store for it to its default */
  async delete(key: string): Promise<boolean> {
    const deleted = await navigator.locks.request(this.lockName(key), () =>
      this.blob.delete(key)
    )
    if (deleted) {
      await this.stores.get(key)?.refresh()
      this.broadcast(key)
    }
    return deleted
  }

  private lockName(key: string) {
    return `taut:${this.namespace}:${key}`
  }

  private async read<T extends JsonValue>(
    key: string,
    defaultValue: T
  ): Promise<T> {
    const raw = await this.blob.read(key)
    if (raw === null) return defaultValue
    try {
      return JSON.parse(raw)
    } catch {
      return defaultValue
    }
  }

  private open<T extends JsonValue>(
    key: string,
    defaultValue: T
  ): StoredStore<T> {
    this.listen()
    const local = new Store<T>(defaultValue)
    const lock = this.lockName(key)
    const refresh = async () => {
      const saved = await navigator.locks.request(lock, () =>
        this.read(key, defaultValue)
      )
      local.set(saved)
      return saved
    }
    const update = async (change: (value: T) => T): Promise<T> => {
      local.update(change)
      try {
        return await navigator.locks.request(lock, async () => {
          const next = change(await this.read(key, defaultValue))
          if (!(await this.blob.write(key, JSON.stringify(next)))) {
            throw new Error(`Couldn't save ${key}`)
          }
          local.set(next)
          this.broadcast(key)
          return next
        })
      } catch (err) {
        // the change wasn't saved, so go back to what is
        await refresh().catch(() => {})
        throw err
      }
    }
    return {
      get: local.get,
      subscribe: local.subscribe,
      use: local.use,
      ready: refresh().then(
        () => {},
        (err) =>
          console.error(`[Taut] Couldn't load ${this.namespace} ${key}:`, err)
      ),
      set: (value) => update(() => value),
      update,
      refresh,
    }
  }

  /** tells every tab's stores to refresh */
  private broadcast(key?: string) {
    if (this.signal?.aborted) announceStorageChange(this.namespace, key)
    else this.listen().postMessage({ key })
  }

  /** the namespace's BroadcastChannel, created on first use */
  private listen(): BroadcastChannel {
    if (this.channel) return this.channel
    const channel = new BroadcastChannel(channelName(this.namespace))
    channel.onmessage = (event: MessageEvent<{ key?: string }>) => {
      const { key } = event.data ?? {}
      for (const [stored, store] of this.stores) {
        if (key === undefined || key === stored) store.refresh()
      }
    }
    if (this.signal?.aborted) channel.close()
    else
      this.signal?.addEventListener('abort', () => channel.close(), {
        once: true,
      })
    this.channel = channel
    return channel
  }
}
