// What's new: which releases in CHANGELOG.md this install hasn't seen yet

import type { Release } from '../shared/changelog'
import { compareVersions } from '../shared/updates'
import { ScopedStorage, type StoredStore } from './api/pluginStorage'
import type { NormalizedBridge } from './bridgeCompat'
import { changelog, tautVersion } from './bundledData'
import { Store } from './store'

type SeenRecord = {
  /** the newest version whose changes have been shown */
  version: string
  /** the version a fresh install started on, never set for an update from before What's new */
  installVersion?: string
  /** a fresh install that hasn't opened What's new yet */
  welcome?: boolean
}

export class WhatsNew {
  /** every bundled release, newest first */
  readonly releases: Release[] = changelog
  /** releases newer than the last one seen, newest first, empty until `init` */
  readonly unseen = new Store<Release[]>([])
  /** a fresh install, until What's new is first opened */
  readonly welcome = new Store(false)
  /** the version a fresh install started on, where its welcome sits in the changelog */
  readonly installVersion = new Store<string | null>(null)
  /** once `init` has read what's been seen */
  readonly loaded = new Store(false)
  private readonly seen: StoredStore<SeenRecord | null>

  constructor(bridge: NormalizedBridge) {
    this.seen = new ScopedStorage(
      bridge.blobStore('whats_new'),
      'whats_new'
    ).store<SeenRecord | null>('seen', null)
    // changes made locally or in another tab
    this.seen.subscribe(() => this.apply())
  }

  /** an update from before What's new existed only sees the newest release */
  async init(newInstall: boolean) {
    const first: SeenRecord = newInstall
      ? { version: tautVersion, installVersion: tautVersion, welcome: true }
      : { version: this.releases[1]?.version ?? '0.0.0' }
    try {
      await this.seen.ready
      if (!this.seen.get()) await this.seen.update((stored) => stored ?? first)
    } catch (err) {
      console.error("[Taut] Couldn't load What's new state:", err)
    }
    this.apply()
    this.loaded.set(true)
  }

  async markSeen() {
    try {
      await this.seen.update((stored) => {
        const installVersion = stored && installedOn(stored)
        return {
          // another tab may already be on a newer Taut
          version:
            stored && compareVersions(stored.version, tautVersion) > 0
              ? stored.version
              : tautVersion,
          ...(installVersion ? { installVersion } : {}),
        }
      })
    } catch (err) {
      console.error("[Taut] Couldn't save What's new state:", err)
    }
  }

  private apply() {
    const record = this.seen.get()
    if (!record) return
    this.welcome.set(record.welcome === true)
    this.installVersion.set(installedOn(record) ?? null)
    this.unseen.set(
      this.releases.filter(
        (release) => compareVersions(release.version, record.version) > 0
      )
    )
  }
}

// a 3.0.0 record from before installVersion: a fresh install that hasn't opened What's new is still on its first version
// todo: remove this once people are on 3.0.1+
const installedOn = (record: SeenRecord) =>
  record.installVersion ?? (record.welcome ? record.version : undefined)
