// Persistent cache with per-item TTL and fetch deduplication for plugin use

import type { BlobStore } from '../../shared/TautBridge'

type CacheEntry<T> = { value: T; ts: number }
export type CacheOptions = { ttl: number; maxSize?: number }

/**
 * Persistent TTL cache with fetch-dedup
 */
export class Cache<T> {
  private storageKey: string
  private ttl: number
  private maxSize?: number
  private memory = new Map<string, CacheEntry<T>>()
  private pending = new Map<string, Promise<T>>()
  private revision = 0
  private generation = 0
  private writeQueue = Promise.resolve()

  constructor(
    private blob: BlobStore,
    cacheKey: string,
    options: CacheOptions
  ) {
    this.storageKey = cacheKey
    this.ttl = options.ttl
    this.maxSize = options.maxSize
  }

  private fresh(entry: CacheEntry<T>): boolean {
    return Date.now() - entry.ts < this.ttl
  }

  private persist() {
    const value = JSON.stringify(Object.fromEntries(this.memory))
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await this.blob.write(this.storageKey, value)
      })
  }

  async load() {
    if (this.revision !== 0) return
    const revision = this.revision
    try {
      const raw = await this.blob.read(this.storageKey)
      if (!raw || revision !== this.revision || this.revision !== 0) return
      const data = JSON.parse(raw) as Record<string, CacheEntry<T>>
      for (const [k, entry] of Object.entries(data)) {
        if (entry && typeof entry.ts === 'number' && this.fresh(entry)) {
          this.memory.set(k, entry)
        }
      }
    } catch {}
  }

  get(key: string): T | undefined {
    const entry = this.memory.get(key)
    if (!entry) return undefined
    if (!this.fresh(entry)) {
      this.memory.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T): void {
    this.revision++
    this.memory.set(key, { value, ts: Date.now() })
    if (this.maxSize !== undefined && this.memory.size > this.maxSize) {
      for (const k of [...this.memory.keys()].slice(0, 100)) {
        this.memory.delete(k)
      }
    }
    this.persist()
  }

  async fetch(key: string, fetcher: () => Promise<T>): Promise<T> {
    const entry = this.memory.get(key)
    if (entry && this.fresh(entry)) return entry.value

    const existing = this.pending.get(key)
    if (existing) return existing

    const generation = this.generation
    const promise = fetcher().then((value) => {
      if (generation === this.generation) this.set(key, value)
      return value
    })
    this.pending.set(key, promise)
    promise
      .finally(() => {
        if (this.pending.get(key) === promise) this.pending.delete(key)
      })
      .catch(() => {})
    return promise
  }

  clear(): void {
    this.revision++
    this.generation++
    this.memory.clear()
    this.pending.clear()
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await this.blob.delete(this.storageKey)
      })
  }
}

export function bindCache(blob: BlobStore) {
  return class BoundCache<T> extends Cache<T> {
    constructor(cacheKey: string, options: CacheOptions) {
      super(blob, cacheKey, options)
    }
  }
}
