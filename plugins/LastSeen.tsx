// Shows when someone was last seen on their profile

import { type RtmEvent, TautPlugin } from '$taut'

type PresenceProps = {
  showText?: boolean
  isActive?: boolean
  isSelf?: boolean
  className?: string
}
type ProfileProps = { member?: { id?: string } }
type HoverCardProps = { memberId?: string }
type LocalTimeProps = { member?: { id?: string } }
type SearchResponse = { messages?: { matches?: { ts?: string }[] } }
type StoreMessage = {
  user?: unknown
  ts?: unknown
  bot_id?: unknown
  app_id?: unknown
}

const MAX_SEEN = 2000
const SCAN_EVERY = 15_000

/** the id, unless a bot posted under it with an xoxp */
const human = (msg: RtmEvent | undefined, id: unknown) =>
  msg && typeof id === 'string' && !msg.bot_id && !msg.app_id ? id : undefined

const when = (event: RtmEvent): number => {
  const at = Number.parseFloat(event.event_ts ?? event.ts ?? '')
  return at > 0 ? at * 1000 : Date.now()
}

const ACTIVITY: Record<
  string,
  (event: RtmEvent) => string | string[] | undefined
> = {
  // an away also arrives in bulk on subscribe, so only active means "now"
  presence_change: (e) =>
    e.presence === 'active'
      ? Array.isArray(e.users)
        ? (e.users as string[])
        : e.user
      : undefined,
  user_typing: (e) => e.user,
  // a reply carries the parent's own edited.user, from whenever that edit was
  message: (e) =>
    human(e, e.user) ??
    (e.subtype === 'message_changed'
      ? human(e.message, e.message?.edited?.user)
      : undefined),
  reaction_added: (e) => e.user,
  reaction_removed: (e) => e.user,
  pin_added: (e) => e.user,
  pin_removed: (e) => e.user,
  file_shared: (e) => (typeof e.user_id === 'string' ? e.user_id : undefined),
  sh_room_join: (e) => e.user,
}

function ago(at: number): string {
  const elapsed = Date.now() - at
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, size] of [
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
  ] as const)
    if (elapsed >= size)
      return format.format(-Math.max(1, Math.floor(elapsed / size)), unit)
  return 'just now'
}

export default class LastSeen extends TautPlugin<typeof LastSeen> {
  static readonly id = 'LastSeen'
  static readonly pluginName = 'Last Seen'
  static readonly description =
    'Shows when someone was last seen on their profile'
  static readonly authors = ['jeremy', 'rowan'] as const
  static readonly category = 'people'
  static readonly defaultConfig = {
    enabled: false,
    showLastMessage: true,
    showObservedPresence: true,
  }

  /** their last visible message in ms */
  private messages = new this.api.Cache<number | null>('last_message', {
    ttl: 6 * 60 * 60 * 1000,
    maxSize: 2000,
  })
  /** when we last saw each person do something, in ms */
  private seen = new this.api.Cache<number>('observed', { maxSize: MAX_SEEN })

  private Surface = React.createContext<
    { userId?: string; card?: boolean } | undefined
  >(undefined)
  private scanned = 0

  async start() {
    await this.seen.load()
    await this.messages.load()
    if (this.api.signal.aborted) return

    if (this.config.showObservedPresence) {
      for (const [type, who] of Object.entries(ACTIVITY))
        this.api.rtm.on(type, (event) => this.sighting(who(event), when(event)))
      this.readStore()
    }

    this.api.patchComponent<ProfileProps>(
      'RimetoProfilePresence',
      (Original) => (props) => (
        <this.Surface.Provider value={{ userId: props.member?.id }}>
          <Original {...props} />
        </this.Surface.Provider>
      )
    )
    this.api.patchComponent<HoverCardProps>(
      'MemberProfileHoverCard',
      (Original) => (props) => (
        <this.Surface.Provider value={{ userId: props.memberId, card: true }}>
          <Original {...props} />
        </this.Surface.Provider>
      )
    )

    this.api.patchComponent<PresenceProps>(
      'Presence',
      (Original) => (props) => {
        const surface = React.useContext(this.Surface)
        const id =
          props.showText && !props.isActive && !props.isSelf && !surface?.card
            ? surface?.userId
            : undefined
        const seen = this.useLastSeen(id)
        if (!seen) return <Original {...props} />
        return (
          <>
            <Original {...props} showText={false} />
            <span className="padding_left_50 taut-last-seen" aria-hidden="true">
              {`Last seen ${ago(seen)}`}
            </span>
          </>
        )
      }
    )

    // the hovercard shows a dot with no words, so it gets a line of its own
    this.api.patchComponent<LocalTimeProps>(
      'LocalTime',
      (Original) => (props) => {
        const surface = React.useContext(this.Surface)
        const id = surface?.card ? props.member?.id : undefined
        return (
          <>
            <Original {...props} />
            {id ? <this.CardLine userId={id} /> : null}
          </>
        )
      }
    )

    this.api.setStyle(`
      .taut-last-seen__card {
        display: block;
        margin-top: 2px;
        font-size: 13px;
        color: rgba(var(--sk_foreground_high_solid, 134, 134, 134), 1);
      }
    `)

    this.log('Started')
  }

  private readStore() {
    if (Date.now() - this.scanned < SCAN_EVERY) return
    this.scanned = Date.now()
    const messages = this.api.redux.getStore()?.getState()?.messages
    if (!messages || typeof messages !== 'object') return
    // both levels keep their real keys on the prototype
    const keys = (value: object) => Object.keys(Object.getPrototypeOf(value))
    for (const channel of keys(messages)) {
      const bucket = messages[channel]
      if (!bucket || typeof bucket !== 'object') continue
      for (const ts of keys(bucket)) {
        const msg = bucket[ts] as StoreMessage | undefined
        if (!msg || typeof msg !== 'object' || msg.bot_id || msg.app_id)
          continue
        if (typeof msg.user === 'string')
          this.sighting(msg.user, Number.parseFloat(String(msg.ts)) * 1000)
      }
    }
  }

  private useLastSeen(userId: string | undefined) {
    const [seen, setSeen] = React.useState(0)
    React.useEffect(() => {
      if (!userId) return setSeen(0)
      this.readStore()
      let live = true
      const settle = (message: number | null) => {
        if (!live) return
        const observed =
          this.config.showObservedPresence === false
            ? 0
            : (this.seen.get(userId) ?? 0)
        setSeen(Math.max(observed, message ?? 0))
      }
      settle(null)
      if (this.config.showLastMessage)
        this.lastMessageOf(userId)
          .then(settle)
          .catch(() => {})
      return () => {
        live = false
      }
    }, [userId])
    return seen
  }

  private CardLine = ({ userId }: { userId: string }) => {
    const seen = this.useLastSeen(userId)
    const presence = this.api.redux.useReduxState(
      (state) => state.presence?.[userId]?.presence
    )
    if (!seen || presence === 'active') return null
    return (
      <span
        className="taut-last-seen__card"
        title={new Date(seen).toLocaleString()}
      >
        {`Last seen ${ago(seen)}`}
      </span>
    )
  }

  private sighting(who: string | string[] | undefined, at: number) {
    if (!who || !(at > 0)) return
    for (const id of typeof who === 'string' ? [who] : who) {
      const known = this.seen.get(id)
      if (known === undefined || known < at) this.seen.set(id, at)
    }
  }

  private lastMessageOf(userId: string) {
    return this.messages.fetch(userId, async () => {
      const res = await this.api.userAPI<SearchResponse>('search.messages', {
        query: `from:<@${userId}>`,
        sort: 'timestamp',
        sort_dir: 'desc',
        count: '1',
      })
      const ts = res.messages?.matches?.[0]?.ts
      const at = ts ? Number.parseFloat(ts) * 1000 : 0
      return at || null
    })
  }
}
