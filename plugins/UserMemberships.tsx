import { TautPlugin } from '$taut'
import {
  getActiveTeam,
  type LocalConfig,
  type LocalConfigTeam,
  readLocalConfig,
} from '../app/slack/localConfig.ts'

const INSTALLS_TTL = 30 * 60 * 1000 // 30 minutes
const MAX_PAGES = 100
const MAX_VISIBLE_CHANNELS = 20

const PERMISSION_ERROR_HINTS = [
  'invalid_auth',
  'enterprise_is_restricted',
  'not_authorized',
  'not_allowed_token_type',
  'missing_scope',
  'account_inactive',
]

type Conversation = {
  id: string
  name?: string
  user?: string

  created?: number
  creator?: string

  is_channel?: boolean
  is_group?: boolean
  is_private?: boolean
  is_im?: boolean
  is_mpim?: boolean
  is_archived?: boolean
  is_member?: boolean

  is_shared?: boolean
  is_org_shared?: boolean
  is_ext_shared?: boolean
  context_team_id?: string
  updated?: number
  name_normalized?: string
  is_general?: boolean
}

type ConversationsResponse = {
  ok: boolean
  error?: string
  channels?: Conversation[]
  response_metadata?: {
    next_cursor?: string
  }
}

type ProfileShellProps = {
  profileId?: string
  uiComponentName?: string
  children?: React.ReactNode
}

type MembershipFilter =
  | 'all'
  | 'public'
  | 'private'
  | 'dms'
  | 'group-dms'
  | 'created'
  | 'archived'

type FilterButtonProps = {
  label: string
  count: number
  active: boolean
  onClick: () => void
}

export default class UserMemberships extends TautPlugin<
  typeof UserMemberships
> {
  static readonly id = 'UserMemberships'
  static readonly pluginName = 'User Memberships'
  static readonly description =
    'Shows the channels and conversations a user belongs to on their profile'
  static readonly authors = ['fantamomo'] as const
  static readonly category = 'people'
  static readonly hackClubOnly = false

  static readonly defaultConfig = {
    enabled: false,
  }

  private membershipsCache = new this.api.Cache<Conversation[] | null>(
    'user_memberships',
    {
      ttl: INSTALLS_TTL,
      maxSize: 2000,
    }
  )

  private sessionChoice: {
    account?: string
    teamId?: string
  } = {}

  async start() {
    await this.membershipsCache.load()

    if (this.api.signal.aborted) return

    this.api.patchComponent<{ children?: unknown }>(
      'Content',
      (Original) => (props) => {
        const children = props.children

        if (!React.isValidElement<ProfileShellProps>(children)) {
          return <Original {...props} />
        }

        const existing = children.props.children

        if (!Array.isArray(existing)) {
          return <Original {...props} />
        }

        const userId = children.props.profileId

        if (
          children.props.uiComponentName !== 'rimeto_member_profile_flexpane' ||
          !userId ||
          !/^[UW][A-Z0-9]+$/.test(userId)
        ) {
          return <Original {...props} />
        }

        const sections = existing.map((child) => {
          if (
            !React.isValidElement<{
              'data-qa'?: string
              children?: React.ReactNode
            }>(child) ||
            child.props['data-qa'] !== 'member_profile_pane'
          ) {
            return child
          }

          return React.cloneElement(
            child,
            undefined,
            child.props.children,
            <this.MembershipsBlock
              key="taut-user-memberships"
              userId={userId}
            />
          )
        })

        return (
          <Original
            {...props}
            children={React.cloneElement(children, undefined, ...sections)}
          />
        )
      }
    )

    this.injectStyles()
    this.log('Started')
  }

  private looksLikePermissionError(message: string): boolean {
    const lower = message.toLowerCase()

    return PERMISSION_ERROR_HINTS.some((hint) => lower.includes(hint))
  }

  private appSessions(
    active: LocalConfigTeam | undefined,
    config: LocalConfig
  ): LocalConfigTeam[] {
    if (!active?.id || !active.user_id || !active.token) {
      return []
    }

    return [
      active,
      ...Object.values(config.teams ?? {}).filter(
        (team) =>
          team.id !== active.id &&
          team.user_id === active.user_id &&
          !!team.token &&
          typeof team.enterprise_id === 'string' &&
          team.enterprise_id === active.id
      ),
    ]
  }

  private async tryFetchMemberships(
    userId: string,
    tokenOverride: string,
    onUpdate?: (conversations: Conversation[]) => void
  ): Promise<
    { ok: true; conversations: Conversation[] } | { ok: false; error: string }
  > {
    try {
      const conversations: Conversation[] = []
      const seenCursors = new Set<string>()

      let nextCursor: string | undefined

      for (let page = 0; page < MAX_PAGES; page++) {
        if (this.api.signal.aborted) {
          return {
            ok: false,
            error: 'Request aborted',
          }
        }

        const res = await this.api.userAPI<ConversationsResponse>(
          'users.conversations',
          {
            user: userId,
            // we're requesting all types of conversations, slack only returns the conversations that the user is a member of
            types: 'public_channel,private_channel,mpim,im',
            // 999 is the max limit for this api, and we need it (because some users have a lot of conversations (so around 10.877))
            limit: '999',
            ...(nextCursor ? { cursor: nextCursor } : {}),
            token: tokenOverride,
          },
          {
            signal: this.api.signal,
          }
        )

        if (!res.ok) {
          return {
            ok: false,
            error: res.error || 'users.conversations failed',
          }
        }

        // append the page as soon as it arrives.
        conversations.push(...(res.channels ?? []))
        onUpdate?.([...conversations])

        // only next_cursor determines whether pagination ends.
        const cursor = res.response_metadata?.next_cursor?.trim()

        if (!cursor) {
          return {
            ok: true,
            conversations,
          }
        }

        if (seenCursors.has(cursor)) {
          return {
            ok: false,
            error: `Repeated pagination cursor: ${cursor}`,
          }
        }

        seenCursors.add(cursor)
        nextCursor = cursor
      }

      return {
        ok: false,
        error: `Pagination limit reached (${MAX_PAGES} pages)`,
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private async fetchMemberships(
    userId: string,
    onUpdate?: (conversations: Conversation[]) => void
  ): Promise<Conversation[] | null> {
    return this.membershipsCache.fetch(userId, async () => {
      const config = readLocalConfig()
      const active = getActiveTeam(config)

      const account =
        active?.id && active.user_id
          ? `${active.id}:${active.user_id}`
          : undefined

      if (account !== this.sessionChoice.account) {
        this.sessionChoice = { account }
      }

      const sessions = this.appSessions(active, config)

      const preferred = sessions.find(
        (session) => session.id === this.sessionChoice.teamId
      )

      const ordered = preferred
        ? [preferred, ...sessions.filter((session) => session !== preferred)]
        : sessions

      let lastError = 'No active Slack workspace session'

      for (const session of ordered) {
        if (!session.token) continue

        const result = await this.tryFetchMemberships(
          userId,
          session.token,
          onUpdate
        )

        if (result.ok) {
          this.sessionChoice.teamId = session.id

          this.log(
            'Fetched user memberships:',
            userId,
            result.conversations.length,
            'using workspace session',
            session.id
          )

          return result.conversations
        }

        lastError = result.error

        // try another session only for permission/auth errors
        if (!this.looksLikePermissionError(result.error)) {
          break
        }
      }

      this.log('fetchMemberships failed:', lastError)
      return null
    })
  }

  private useMemberships(userId: string | undefined) {
    const [conversations, setConversations] = React.useState<
      Conversation[] | null
    >(() => (userId ? (this.membershipsCache.get(userId) ?? null) : null))

    React.useEffect(() => {
      let cancelled = false

      if (!userId) {
        setConversations(null)
        return
      }

      setConversations(this.membershipsCache.get(userId) ?? null)

      this.fetchMemberships(userId, (partial) => {
        if (!cancelled) {
          setConversations(partial)
        }
      })
        .then((result) => {
          if (!cancelled && result !== null) {
            setConversations(result)
          }
        })
        .catch((err) => {
          this.log(
            'Membership loading error:',
            err instanceof Error ? err.message : String(err)
          )
        })

      return () => {
        cancelled = true
      }
    }, [userId])

    return conversations
  }

  private ConversationLabel = (props: {
    conversation: Conversation
    showSpecificType?: boolean
  }) => {
    const { conversation } = props
    const Mrkdwn = this.api.elements.MrkdwnElement

    const type = props.showSpecificType
      ? ` (${this.conversationType(conversation)})`
      : ``

    if (conversation.name) {
      return (
        <>
          {conversation.name}
          {type}
        </>
      )
    }

    if (conversation.is_im) {
      return conversation.user ? (
        <Mrkdwn text={`<@${conversation.user}>${type}`} />
      ) : (
        <>{`Direct message: ${conversation.id}${type}`}</>
      )
    }

    if (conversation.is_mpim) {
      return <Mrkdwn text={`<#${conversation.id}>${type}`} />
    }

    return (
      <>
        {conversation.id}
        {type}
      </>
    )
  }

  private conversationType(conversation: Conversation): string {
    if (conversation.is_im) return 'DM'
    if (conversation.is_mpim) return 'Group DM'
    if (conversation.is_private) return 'Private'

    return 'Public'
  }

  private isChannel(conversation: Conversation): boolean {
    return !conversation.is_im && !conversation.is_mpim
  }

  private isCreatedByUser(
    conversation: Conversation,
    userId: string | undefined
  ): boolean {
    return !!userId && conversation.creator === userId
  }

  private FilterButton = (props: FilterButtonProps) => (
    <button
      type="button"
      className={`taut-user-memberships__filter${
        props.active ? ' is-active' : ''
      }`}
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      <span>{props.label}</span>

      <span className="taut-user-memberships__filter-count">
        {props.count.toLocaleString()}
      </span>
    </button>
  )

  private ChannelMentions = (props: {
    conversations: Conversation[]
    userId?: string
    showCreatorIndicator?: boolean
  }) => {
    const Mrkdwn = this.api.elements.MrkdwnElement

    if (!Mrkdwn) {
      return (
        <>
          {props.conversations
            .map((conversation) => `<#${conversation.id}>`)
            .join(', ')}
        </>
      )
    }

    // keep Slack-native channel mentions
    // than append the creator indicator for owned channels
    const text = props.conversations
      .map((conversation) => {
        const mention = `<#${conversation.id}>`

        return this.isCreatedByUser(conversation, props.userId) &&
          props.showCreatorIndicator
          ? `${mention} (Creator)`
          : mention
      })
      .join('\n')

    return <Mrkdwn text={text} />
  }

  private MembershipsBlock = (props: { userId?: string }) => {
    const conversations = this.useMemberships(props.userId)

    const [activeFilter, setActiveFilter] =
      React.useState<MembershipFilter>('all')

    const [showAll, setShowAll] = React.useState(false)

    if (!conversations || conversations.length === 0) {
      return null
    }

    const channels = conversations.filter((conversation) =>
      this.isChannel(conversation)
    )

    const publicChannels = channels.filter(
      (conversation) => !conversation.is_private
    )

    const privateChannels = channels.filter(
      (conversation) => !!conversation.is_private
    )

    const directDMs = conversations.filter(
      (conversation) => !!conversation.is_im
    )

    const groupDMs = conversations.filter(
      (conversation) => !!conversation.is_mpim
    )

    const archived = channels.filter(
      (conversation) => !!conversation.is_archived
    )

    const createdChannels = channels.filter((conversation) =>
      this.isCreatedByUser(conversation, props.userId)
    )

    const filteredConversations = conversations.filter((conversation) => {
      switch (activeFilter) {
        case 'public':
          return this.isChannel(conversation) && !conversation.is_private

        case 'private':
          return this.isChannel(conversation) && !!conversation.is_private

        case 'dms':
          return !!conversation.is_im

        case 'group-dms':
          return !!conversation.is_mpim

        case 'created':
          return (
            this.isChannel(conversation) &&
            this.isCreatedByUser(conversation, props.userId)
          )

        case 'archived':
          return this.isChannel(conversation) && !!conversation.is_archived

        case 'all':
        default:
          return true
      }
    })

    const visibleConversations = showAll
      ? filteredConversations
      : filteredConversations.slice(0, MAX_VISIBLE_CHANNELS)

    const remaining = Math.max(
      0,
      filteredConversations.length - visibleConversations.length
    )

    const filters: {
      id: MembershipFilter
      label: string
      count: number
    }[] = [
      {
        id: 'all',
        label: 'All',
        count: conversations.length,
      },
      {
        id: 'public',
        label: 'Public',
        count: publicChannels.length,
      },
      {
        id: 'private',
        label: 'Private',
        count: privateChannels.length,
      },
      {
        id: 'dms',
        label: 'DMs',
        count: directDMs.length,
      },
      {
        id: 'group-dms',
        label: 'Group DMs',
        count: groupDMs.length,
      },
      {
        id: 'created',
        label: 'Created',
        count: createdChannels.length,
      },
      {
        id: 'archived',
        label: 'Archived',
        count: archived.length,
      },
    ]

    return (
      <div className="taut-user-memberships p-r_member_profile_section">
        <div className="taut-user-memberships__heading">
          <div className="taut-user-memberships__title">
            MEMBERSHIPS ({conversations.length.toLocaleString()})
          </div>

          <div className="taut-user-memberships__filters">
            {filters.map((filter) => (
              <this.FilterButton
                key={filter.id}
                label={filter.label}
                count={filter.count}
                active={activeFilter === filter.id}
                onClick={() => {
                  setActiveFilter((current) =>
                    current === filter.id ? 'all' : filter.id
                  )

                  setShowAll(false)
                }}
              />
            ))}
          </div>
        </div>

        {visibleConversations.length > 0 && (
          <div className="taut-user-memberships__other">
            {visibleConversations.map((conversation) => (
              <div key={conversation.id} className="taut-user-memberships__dm">
                {this.isChannel(conversation) ? (
                  <this.ChannelMentions
                    conversations={[conversation]}
                    userId={props.userId}
                    showCreatorIndicator={activeFilter !== 'created'}
                  />
                ) : (
                  <this.ConversationLabel
                    conversation={conversation}
                    showSpecificType={
                      activeFilter !== 'dms' && activeFilter !== 'group-dms'
                    }
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {remaining > 0 && (
          <button
            type="button"
            className="taut-user-memberships__more"
            onClick={() => setShowAll(true)}
          >
            {remaining.toLocaleString()} More
          </button>
        )}

        {showAll && filteredConversations.length > MAX_VISIBLE_CHANNELS && (
          <button
            type="button"
            className="taut-user-memberships__more"
            onClick={() => setShowAll(false)}
          >
            Show less
          </button>
        )}

        {visibleConversations.length === 0 && (
          <div className="taut-user-memberships__empty">
            No conversations in this category.
          </div>
        )}
      </div>
    )
  }

  private injectStyles() {
    this.api.setStyle(`
      .taut-user-memberships {
        display: block;
        padding: 16px;
        border-top: 1px solid rgba(var(--sk_foreground_low, #1d1c1d), .13);
        min-width: 0;
      }
      
      .taut-user-memberships__heading {
        margin-bottom: 8px;
      }
      
      .taut-user-memberships__title {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        opacity: 0.7;
        margin-bottom: 8px;
      }
      
      .taut-user-memberships__filters {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 8px 0 12px;
      }
      
      .taut-user-memberships__filter {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border: 1px solid rgba(134, 134, 134, 0.25);
        border-radius: 4px;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
        transition:
        background 100ms ease,
        border-color 100ms ease;
      }
      
      .taut-user-memberships__filter:hover {
        background: rgba(134, 134, 134, 0.12);
      }
      
      .taut-user-memberships__filter.is-active {
        background: rgba(29, 155, 209, 0.12);
        border-color: rgba(29, 155, 209, 0.45);
      }
      
      .taut-user-memberships__filter-count {
        opacity: 0.65;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      
      .taut-user-memberships__list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 320px;
        overflow-y: auto;
      }
      
      .taut-user-memberships__item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 6px;
        background: rgba(134, 134, 134, 0.09);
        color: inherit;
        text-decoration: none;
        font-size: 12px;
        min-width: 0;
      }
      
      .taut-user-memberships__item:hover {
        background: rgba(134, 134, 134, 0.16);
      }
      
      .taut-user-memberships__name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: inherit;
        text-decoration: none;
      }
      
      .taut-user-memberships__name:hover {
        text-decoration: underline;
      }
      
      .taut-user-memberships__meta,
      .taut-user-memberships__type {
        opacity: 0.55;
        font-size: 10px;
        flex-shrink: 0;
      }
      
      .taut-user-memberships__more {
        display: inline-block;
        margin: 8px 6px 0 0;
        padding: 4px 8px;
        border: 1px solid rgba(134, 134, 134, 0.25);
        border-radius: 4px;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      
      .taut-user-memberships__more:hover {
        background: rgba(134, 134, 134, 0.12);
      }
      
      .taut-user-memberships__other {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: 8px;
      }
      
      .taut-user-memberships__dm {
        font-size: 12px;
        overflow-wrap: anywhere;
      }
      
      .taut-user-memberships__empty {
        padding: 8px 0;
        font-size: 12px;
        opacity: 0.65;
      }
    `)
  }
}
