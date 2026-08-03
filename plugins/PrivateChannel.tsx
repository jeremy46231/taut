// Lets you see and mention private channels you aren't in (uses the flaron index)

import { TautPlugin } from '$taut'

const FLARON = 'https://flaron.halceon.dev'
// Re-pull the full admin export at most this often
const EXPORT_TTL = 6 * 60 * 60 * 1000

type ShadowRecord = { name: string; previousNames?: string[] }
type Snapshot = { ts: number; entries: Record<string, ShadowRecord> }
type ExportEntry = {
  latest?: string
  private?: boolean
  history?: Array<{ name?: string }>
}

export default class PrivateChannel extends TautPlugin {
  static readonly id = 'PrivateChannel'
  static readonly pluginName = 'Private Channel'
  static readonly description =
    "Lets you see and mention private channels you aren't in (uses the <https://flaron.halceon.dev|flaron> index)"
  static readonly defaultConfig = `
    // Lets you see and mention private channels you aren't in
    "PrivateChannel": {
      "enabled": false
    }
  `
  static readonly authors = '<@U06UYA5GMB5>'

  /** key: channel id, layered on top of Slack's cache */
  private shadows = new Map<string, ShadowRecord>()
  /** ids we've already tried to resolve from flaron */
  private resolved = new Set<string>()
  /** names we've already tried to resolve from flaron */
  private resolvedNames = new Set<string>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  private get adminKey(): string {
    const key = this.config.adminKey
    return typeof key === 'string' ? key.trim() : ''
  }

  async start() {
    const snapshot = await this.api.storage.get<Snapshot | null>(
      'channels',
      null
    )
    if (this.api.signal.aborted) return
    if (snapshot?.entries) {
      for (const [id, rec] of Object.entries(snapshot.entries)) {
        if (rec?.name) this.shadows.set(id, rec)
      }
    }

    this.api.redux.patchSlice<{
      name?: string
      isNonExistent?: boolean
      isUnknown?: boolean
    }>(
      'channels',
      (id, channel) => {
        const rec = this.shadows.get(id)
        if (!rec) return channel
        if (channel?.name && !channel.isNonExistent && !channel.isUnknown)
          return channel
        return this.api.channels.makeChannelObject({
          id,
          name: rec.name,
          isPrivate: true,
          previousNames: rec.previousNames,
        })
      },
      () => this.shadows.keys()
    )
    this.api.redux.refresh()

    this.patchThunks()
    this.patchChannelRendering()

    // If we have an admin key, keep the full export up to date in the background
    if (this.adminKey && (!snapshot || Date.now() - snapshot.ts > EXPORT_TTL)) {
      this.loadExport().catch((err) => this.log('export failed', err))
    }

    this.log('Started')
  }

  /** Re-inject after `shadows` changed, and persist the snapshot (debounced). */
  private commit() {
    this.api.redux.refresh()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      const entries: Record<string, ShadowRecord> = {}
      for (const [id, rec] of this.shadows) entries[id] = rec
      void this.api.storage.set<Snapshot>('channels', {
        ts: Date.now(),
        entries,
      })
    }, 1000)
  }

  private async loadExport() {
    const res = await fetch(`${FLARON}/admin/export`, {
      headers: { 'x-admin-key': this.adminKey },
      signal: this.api.signal,
    })
    if (!res.ok) throw new Error(`export ${res.status}`)
    const data = (await res.json()) as Record<string, ExportEntry>
    if (this.api.signal.aborted) return
    for (const [id, entry] of Object.entries(data)) {
      const name = entry?.latest
      if (!name || entry.private !== true) continue
      const previousNames = (entry.history ?? [])
        .map((h) => h?.name)
        .filter((n): n is string => !!n && n !== name)
      this.shadows.set(id, { name, previousNames })
      this.resolved.add(id)
    }
    this.commit()
    this.log(`loaded ${this.shadows.size} private channels`)
  }

  /** Resolve a channel id -> name from flaron */
  private async resolveById(id: string) {
    if (this.resolved.has(id)) return
    this.resolved.add(id)
    let name = id
    try {
      const res = await fetch(`${FLARON}/cid/${id}`, {
        signal: this.api.signal,
      })
      if (this.api.signal.aborted) return
      if (res.ok) {
        const data = (await res.json()) as { name?: string; created?: number }
        if ('created' in data) return // public channel, ignore
        if (data.name) name = data.name
      }
    } catch {
      return
    }
    if (this.api.signal.aborted) return
    this.shadows.set(id, { name })
    this.commit()
  }

  /**
   * Resolve a complete channel name -> id from flaron and saves to a shadow
   */
  private async resolveByName(query: string): Promise<boolean> {
    const name = query.trim().toLowerCase()
    if (!name || this.resolvedNames.has(name)) return false
    this.resolvedNames.add(name)
    try {
      const res = await fetch(`${FLARON}/cname/${encodeURIComponent(name)}`, {
        signal: this.api.signal,
      })
      if (!res.ok) return false
      const data = (await res.json()) as {
        id?: string
        name?: string
        created?: number
      }
      // Public channels come back with full metadata; leave those to Slack.
      if (
        this.api.signal.aborted ||
        !data?.id ||
        !data.name ||
        'created' in data
      )
        return false
      this.shadows.set(data.id, { name: data.name })
      this.commit()
      return true
    } catch {
      return false
    }
  }

  private patchThunks() {
    this.api.redux.patchThunk(
      'fetchRawChannelsById',
      (original) => (params) => {
        const thunk = original(params)
        return (...args: unknown[]) =>
          Promise.resolve(thunk(...args)).then((res) => {
            const missing = (res as { missing?: string[] })?.missing
            if (Array.isArray(missing)) {
              for (const id of missing) void this.resolveById(id)
            }
            return res
          })
      }
    )

    this.api.redux.patchThunk(
      'autocompleteChannels',
      (original) => (params) => {
        const query =
          typeof params?.query === 'string' ? params.query.trim() : ''
        if (!query) return original(params)
        const q = query.toLowerCase()
        return (...args: unknown[]) => {
          const result = original(params)(...args)
          return Promise.resolve(result).then((local) => {
            // Slack's local tier, has a .promise to the remote tier
            if (!Array.isArray(local)) return local
            // Slack's remote tier (includes local too)
            const slackRemote: unknown = (local as { promise?: unknown })
              .promise

            const merged = Promise.resolve(slackRemote).then(async (remote) => {
              const base = Array.isArray(remote) ? remote : local
              // If Slack found an exact match, don't bother looking up flaron
              const covered = base.some((r) => {
                const name = r?.item?.name || r?.name
                return typeof name === 'string' && name.toLowerCase() === q
              })
              if (covered) return base
              // let's check and add flaron shadows
              const added = await this.resolveByName(query)
              if (!added) return base // still no exact match, resolve
              // we just added to the store, so re-run the original thunk to let slack's logic find it
              const rerun = await original(params)(...args)
              // (but no need to await its remote tier, the first run put it in the store)
              return Array.isArray(rerun)
                ? this.mergeChannelResults(base, rerun)
                : base
            })

            // sometimes local is a frozen empty array for some reason, so clone it
            const fresh = local.slice() as unknown[] & { promise?: unknown }
            fresh.promise = merged
            return fresh
          })
        }
      }
    )
  }

  /** Union two result lists, deduped by channel id (base entries win). */
  private mergeChannelResults(
    base: Array<{ item?: { id?: string }; id?: string }>,
    extra: Array<{ item?: { id?: string }; id?: string }>
  ) {
    const seen = new Set<string>()
    for (const r of base) {
      const id = r?.item?.id ?? r?.id
      if (id) seen.add(id)
    }
    const out = [...base]
    for (const r of extra) {
      const id = r?.item?.id ?? r?.id
      if (id && !seen.has(id)) {
        seen.add(id)
        out.push(r)
      }
    }
    return out
  }

  /** A grayed-out channel mention that shows a name/id */
  private renderMissing(name: string) {
    const SvgIcon = this.api.elements.SvgIcon
    return (
      <span className="c-missing_channel--private">
        <SvgIcon inline={true} name="lock" />
        {name}
      </span>
    )
  }

  private patchChannelRendering() {
    this.api.patchComponent<{
      id?: string
      channelName?: string
      isPrivate?: boolean
      isMember?: boolean
      isNonExistent?: boolean
      isUnknown?: boolean
    }>('BaseMrkdwnChannel', (Original) => (props) => {
      const inaccessible =
        props.isNonExistent ||
        props.isUnknown ||
        (props.isPrivate && !props.isMember)
      if (inaccessible && props.id)
        return this.renderMissing(props.channelName || props.id)

      return <Original {...props} />
    })

    this.api.patchComponent<{ id?: string }>(
      'ListChannelEntity',
      (Original) => (props) => {
        const id = props.id
        const channel = this.api.redux.useReduxState<
          | {
              name?: string
              is_private?: boolean
              is_member?: boolean
              isNonExistent?: boolean
              isUnknown?: boolean
            }
          | undefined
        >((s) => (id ? s.channels?.[id] : undefined))
        const inaccessible =
          !!channel &&
          (channel.isNonExistent ||
            channel.isUnknown ||
            (channel.is_private && !channel.is_member))
        if (inaccessible && id) return this.renderMissing(channel?.name || id)

        return <Original {...props} />
      }
    )
  }
}
