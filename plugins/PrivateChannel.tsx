// Lets you see and mention private channels you aren't in (uses the flaron index)

import { opt, TautPlugin } from '$taut'

const FLARON = 'https://flaron.halceon.dev'
const EXPORT_TTL = 6 * 60 * 60 * 1000
// forget confirmed shadows so channels gone public or joined get resolved by Slack again
const SHADOW_TTL = 24 * 60 * 60 * 1000
// most index entries a single autocomplete query may check against flaron
const MAX_QUERY_LOOKUPS = 5
const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/

type ShadowRecord = { name: string; previousNames?: string[] }
type Confirmed = ShadowRecord & { ts: number }
type Snapshot = {
  /** when the admin export was last pulled */
  ts: number
  index?: Record<string, ShadowRecord>
  confirmed?: Record<string, Confirmed>
  /** pre-verification snapshots, loaded as unverified index entries */
  entries?: Record<string, ShadowRecord>
}
type ExportEntry = {
  latest?: string
  private?: boolean
  history?: Array<{ name?: string }>
}

export default class PrivateChannel extends TautPlugin<typeof PrivateChannel> {
  static readonly id = 'PrivateChannel'
  static readonly pluginName = 'Private Channel'
  static readonly description =
    "Lets you see and mention private channels you aren't in (uses the <https://flaron.halceon.dev|flaron> index)"
  static readonly category = 'app'
  static readonly hackClubOnly = true
  static readonly defaultConfig = {
    enabled: false,
    adminKey: opt.secret('flaron admin key, to index every channel in flaron'),
  }
  static readonly authors = ['jeremy'] as const

  /** channel id -> flaron's name, never a stand-in for a channel Slack can fetch since flaron marks public ones private too */
  private index = new Map<string, ShadowRecord>()
  /** channel id -> channels confirmed inaccessible, layered on Slack's cache */
  private shadows = new Map<string, Confirmed>()
  /** last typed id with no known name, so its mention can autocomplete (never saved) */
  private unnamedId: string | undefined
  /** ids we've already tried to resolve from flaron */
  private resolved = new Set<string>()
  /** flaron lookups by id, shared by everything resolving the same id */
  private lookups = new Map<
    string,
    Promise<{ ok: boolean; name?: string; isPublic?: boolean }>
  >()
  /** names we've already tried to resolve from flaron */
  private resolvedNames = new Set<string>()
  /** channel objects we built, so we can tell our own reads from Slack's */
  private synthesized = new WeakSet<object>()
  private exportTs = 0
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private snapshot = this.api.storage.store<Snapshot | null>('channels', null)

  private get adminKey(): string {
    return this.config.adminKey.trim()
  }

  async start() {
    await this.snapshot.ready
    if (this.api.signal.aborted) return
    this.loadSnapshot(this.snapshot.get())

    this.api.redux.patchSlice<{
      name?: string
      isNonExistent?: boolean
      isUnknown?: boolean
    }>(
      'channels',
      (id, channel) => {
        if (channel?.name && !channel.isNonExistent && !channel.isUnknown)
          return channel
        // an index name only fills a stub Slack gave up on, a missing entry stays missing so Slack still fetches
        const rec =
          this.shadows.get(id) ??
          (channel && this.index.get(id)) ??
          // the id stands in for the name here, so you at least see the id and not "unknown-channel"
          (id === this.unnamedId ? { name: id } : undefined)
        if (!rec) return channel
        const shadow = this.api.channels.makeChannelObject({
          id,
          name: rec.name,
          isPrivate: true,
          previousNames: rec.previousNames,
        })
        this.synthesized.add(shadow)
        return shadow
      },
      () =>
        this.unnamedId
          ? [...this.shadows.keys(), this.unnamedId]
          : this.shadows.keys()
    )
    this.api.redux.refresh()

    this.patchThunks()
    this.patchChannelRendering()

    if (this.adminKey && Date.now() - this.exportTs > EXPORT_TTL) {
      this.loadExport().catch((err) => this.log('export failed', err))
    }

    this.log('Started')
  }

  async stop() {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    await this.save()
  }

  private loadSnapshot(snapshot: Snapshot | null) {
    if (!snapshot) return
    this.exportTs = snapshot.index ? (snapshot.ts ?? 0) : 0
    // older versions saved a channel's id as its name when flaron had none
    for (const [id, rec] of Object.entries(
      snapshot.index ?? snapshot.entries ?? {}
    )) {
      if (rec?.name && rec.name !== id) this.index.set(id, rec)
    }
    const now = Date.now()
    for (const [id, rec] of Object.entries(snapshot.confirmed ?? {})) {
      if (!rec?.name || rec.name === id) continue
      this.index.set(id, { name: rec.name, previousNames: rec.previousNames })
      if (now - (rec.ts ?? 0) < SHADOW_TTL) this.shadows.set(id, rec)
    }
  }

  /** remember a channel Slack can't see, so it renders and autocompletes */
  private confirm(id: string, rec: ShadowRecord) {
    this.index.set(id, rec)
    this.shadows.set(id, { ...rec, ts: Date.now() })
  }

  /** re-inject after a shadow changed, and persist the snapshot (debounced) */
  private commit() {
    this.api.redux.refresh()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), 1000)
  }

  private save() {
    this.saveTimer = null
    const index: Record<string, ShadowRecord> = {}
    for (const [id, rec] of this.index) index[id] = rec
    const confirmed: Record<string, Confirmed> = {}
    for (const [id, rec] of this.shadows) confirmed[id] = rec
    return this.snapshot
      .set({ ts: this.exportTs, index, confirmed })
      .catch((err) => this.log('Could not save', err))
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
      // flaron marks public channels private too, so this doesn't do much...
      // sahil fix it please :3
      if (!name || entry.private !== true) continue
      const previousNames = (entry.history ?? [])
        .map((h) => h?.name)
        .filter((n): n is string => !!n && n !== name)
      this.index.set(id, { name, previousNames })
    }
    this.exportTs = Date.now()
    this.commit()
    this.log(`indexed ${this.index.size} channel names`)
  }

  private fetchFlaron(
    id: string
  ): Promise<{ ok: boolean; name?: string; isPublic?: boolean }> {
    let lookup = this.lookups.get(id)
    if (!lookup) {
      lookup = this.requestFlaron(id)
      this.lookups.set(id, lookup)
      // only answers are remembered, so a failed request is tried again
      lookup.then((found) => {
        if (!found.ok) this.lookups.delete(id)
      })
    }
    return lookup
  }

  private async requestFlaron(
    id: string
  ): Promise<{ ok: boolean; name?: string; isPublic?: boolean }> {
    try {
      const res = await fetch(`${FLARON}/cid/${id}`, {
        signal: this.api.signal,
      })
      if (this.api.signal.aborted) return { ok: false }
      // flaron has no record of it
      if (!res.ok) return { ok: true }
      // unknown ids come back as { id, error: 'nonexistent' }
      const data = (await res.json()) as { name?: string; created?: number }
      // public channels come back with full metadata, private ones {id, name}
      if ('created' in data) {
        this.index.delete(id)
        return { ok: true, isPublic: true }
      }
      return { ok: true, name: data.name }
    } catch {
      return { ok: false }
    }
  }

  /** shadow ids Slack itself failed to resolve, naming them from flaron */
  private onMissing(ids: string[]) {
    const lookups: string[] = []
    let added = false
    for (const id of ids) {
      if (typeof id !== 'string' || this.shadows.has(id)) continue
      const rec = this.index.get(id)
      if (rec) {
        this.confirm(id, rec)
        added = true
      } else {
        lookups.push(id)
      }
    }
    if (added) this.commit()
    for (const id of lookups) this.resolveById(id)
  }

  /** name a channel Slack couldn't resolve, unnamed ones keep Slack's bare-id stub */
  private async resolveById(id: string) {
    if (this.resolved.has(id)) return
    this.resolved.add(id)
    const found = await this.fetchFlaron(id)
    if (!found.ok || found.isPublic || !found.name || this.api.signal.aborted)
      return
    this.confirm(id, { name: found.name })
    this.commit()
  }

  /** make a typed channel id mentionable, returns the name to search it by */
  private async resolveTypedId(id: string): Promise<string | undefined> {
    const cached = this.api.channels.getCachedChannel(id)
    if (cached?.name && !cached.isNonExistent && !cached.isUnknown)
      return cached.name
    // let Slack try first, so we never shadow a channel it knows about
    const res = await this.api.redux.dispatchThunk<{ missing?: string[] }>(
      'fetchAndUpsertChannelsById',
      { ids: [id] }
    )
    if (this.api.signal.aborted) return
    if (!res?.missing?.includes(id))
      return this.api.channels.getCachedChannel(id)?.name
    const known = this.shadows.get(id)?.name
    if (known) return known
    const found = await this.fetchFlaron(id)
    if (!found.ok || found.isPublic || this.api.signal.aborted) return
    if (found.name) {
      this.confirm(id, {
        name: found.name,
        previousNames: this.index.get(id)?.previousNames,
      })
    } else {
      this.unnamedId = id
    }
    this.commit()
    return found.name ?? id
  }

  /** shadow an indexed channel, once flaron confirms Slack can't reach it */
  private async verifyById(id: string): Promise<boolean> {
    if (this.shadows.has(id) || this.resolved.has(id)) return false
    this.resolved.add(id)
    const found = await this.fetchFlaron(id)
    if (!found.ok || found.isPublic || !found.name || this.api.signal.aborted)
      return false
    this.confirm(id, {
      name: found.name,
      previousNames: this.index.get(id)?.previousNames,
    })
    return true
  }

  /** indexed channels matching `query` that Slack has nothing for, best first */
  private candidatesFor(query: string): string[] {
    if (query.length < 2) return []
    const rank = (name: string) =>
      name === query
        ? 0
        : name.startsWith(query)
          ? 1
          : name.includes(query)
            ? 2
            : 3
    const tiers: Array<Array<{ id: string; name: string }>> = [[], [], []]
    for (const [id, rec] of this.index) {
      if (this.shadows.has(id) || this.resolved.has(id)) continue
      // Slack can already find it, so its own searcher covers it
      const cached = this.api.channels.getCachedChannel(id)
      if (cached?.name && !this.synthesized.has(cached)) continue
      let best = 3
      for (const name of [rec.name, ...(rec.previousNames ?? [])])
        best = Math.min(best, rank(name.toLowerCase()))
      if (best < 3) tiers[best].push({ id, name: rec.name })
    }
    return tiers
      .flatMap((tier) => tier.sort((a, b) => a.name.length - b.name.length))
      .slice(0, MAX_QUERY_LOOKUPS)
      .map((c) => c.id)
  }

  /** shadow whatever flaron has for `query` that Slack couldn't find */
  private async resolveByName(query: string): Promise<boolean> {
    const name = query.trim().toLowerCase()
    if (!name) return false
    const candidates = this.candidatesFor(name)
    if (candidates.length) {
      const found = await Promise.all(
        candidates.map((id) => this.verifyById(id))
      )
      if (found.some(Boolean)) {
        this.commit()
        return true
      }
    }
    return this.lookupName(name)
  }

  /** resolve a complete channel name -> id from flaron and save it as a shadow */
  private async lookupName(name: string): Promise<boolean> {
    if (this.resolvedNames.has(name)) return false
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
      // public channels come back with full metadata, leave those to Slack
      if (
        this.api.signal.aborted ||
        !data?.id ||
        !data.name ||
        'created' in data
      )
        return false
      this.confirm(data.id, { name: data.name })
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
            if (Array.isArray(missing)) this.onMissing(missing)
            return res
          })
      }
    )

    this.api.redux.patchThunk(
      'autocompleteChannels',
      (original) => (params) => {
        // the composer passes the typed text, sigil and all
        const raw =
          typeof params?.query === 'string'
            ? params.query.trim().replace(/^#/, '')
            : ''
        const q = raw.toLowerCase()
        if (!q) return original(params)
        const typedId = CHANNEL_ID.test(raw) ? raw : undefined
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
              if (typedId)
                return this.searchTypedId(typedId, base, original, params, args)
              // if Slack found an exact match, don't bother looking up flaron
              const covered = base.some((r) => {
                const name = r?.item?.name || r?.name
                return typeof name === 'string' && name.toLowerCase() === q
              })
              if (covered) return base
              const added = await this.resolveByName(q)
              if (!added) return base
              // we just added to the store, so re-run the original thunk to let slack's logic find it
              const rerun = await original(params)(...args)
              // no need to await its remote tier, the first run put it in the store
              return Array.isArray(rerun)
                ? this.mergeChannelResults(base, rerun)
                : base
            })

            // local is sometimes a frozen empty array
            const fresh = local.slice() as unknown[] & { promise?: unknown }
            fresh.promise = merged
            return fresh
          })
        }
      }
    )
  }

  private async searchTypedId(
    id: string,
    base: Array<{ item?: { id?: string }; id?: string }>,
    original: (params: any) => (...args: unknown[]) => unknown,
    params: { query: string },
    args: unknown[]
  ) {
    if (base.some((r) => (r?.item?.id ?? r?.id) === id)) return base
    // the autocomplete list waits on this, so it's bounded and can't reject
    const name = await Promise.race([
      this.resolveTypedId(id).catch((err) =>
        this.log('Could not resolve', id, err)
      ),
      new Promise<undefined>((resolve) => setTimeout(resolve, 5_000)),
    ])
    if (!name) return base
    const rerun = await original({
      ...params,
      query: params.query.replace(id, name),
    })(...args)
    if (!Array.isArray(rerun)) return base
    const match = rerun.filter((r) => (r?.item?.id ?? r?.id) === id)
    return this.mergeChannelResults(match, base)
  }

  /** union two result lists, deduped by channel id (base entries win) */
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

  /** a grayed-out channel mention that shows a name/id */
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
      // Slack's stubs carry a placeholder name like "unknown-channel"
      const stub = props.isNonExistent || props.isUnknown
      if ((stub || (props.isPrivate && !props.isMember)) && props.id)
        return this.renderMissing((!stub && props.channelName) || props.id)

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
        const stub = channel?.isNonExistent || channel?.isUnknown
        if ((stub || (channel?.is_private && !channel.is_member)) && id)
          return this.renderMissing((!stub && channel?.name) || id)

        return <Original {...props} />
      }
    )

    // Slack labels forwards from a channel it can't see "From a private conversation"
    this.api.patchComponent<{
      channelId?: string
      channelName?: string
      isChannelNonExistent?: boolean
      isPrivate?: boolean
      isMessageNonExistent?: boolean
    }>('BaseMessageAttachmentSlackMessage', (Original) => (props) => {
      const id = props.channelId
      if (!props.isChannelNonExistent || !id) return <Original {...props} />
      return (
        <Original
          {...props}
          channelName={props.channelName || id}
          isPrivate={true}
          isMessageNonExistent={false}
        />
      )
    })
  }
}
