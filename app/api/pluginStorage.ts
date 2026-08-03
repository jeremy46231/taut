// Durable, JSON-oriented key/value storage scoped to one plugin

import type { BlobStore } from '../../shared/TautBridge'

export class ScopedStorage {
  constructor(private blob: BlobStore) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.blob.read(key)
    if (raw === null) return fallback
    try {
      return JSON.parse(raw)
    } catch {
      return fallback
    }
  }
  set<T>(key: string, value: T): Promise<boolean> {
    return this.blob.write(key, JSON.stringify(value))
  }
  delete(key: string): Promise<boolean> {
    return this.blob.delete(key)
  }
  keys(): Promise<string[]> {
    return this.blob.list()
  }
  clear(): Promise<boolean> {
    return this.blob.clear()
  }
}
