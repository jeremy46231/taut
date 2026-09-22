// Shows the user who sent a message via a bot like at-channel

import { type SlackAttachment, type SlackMessage, TautPlugin } from '$taut'

type RelayedMessage = SlackMessage & {
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> }
}

const USER_ID_RE = /^[UW][A-Z0-9]+$/
/** a forward carries no bot id of its own, so this link is the only clue */
const SERVICE_RE = /\/services\/(B[A-Z0-9]+)/

type SearchResult = { messages?: RelayedMessage[] }

/** trusted bots that post for someone, and where each records who */
const RELAY_BOTS: Record<string, (msg: RelayedMessage) => unknown> = {
  // at-channel
  B08G06U6SJG: (msg) => msg.metadata?.event_payload?.source_user_id,
  // Prometheus
  B0AL9MCCBJL: (msg) => msg.metadata?.event_payload?.source_user_id,
  // Slack Extra
  B09QQ24JRL1: (msg) => msg.metadata?.event_payload?.poster,
  // bChannel
  B0BJDMND6HX: (msg) => msg.metadata?.event_payload?.source_user_id,
  // Ping Bot
  B0BEYA2UKPZ: (msg) => msg.metadata?.event_payload?.source_user_id,
  // nChannel
  B0BJB280JP8: (msg) => msg.metadata?.event_payload?.source_user_id,
  // shroud
  B07KBDVFXJP: (msg) => msg.metadata?.event_payload?.source_user_id,
  B0B4KEDP7BL: (msg) => msg.metadata?.event_payload?.source_user_id, // demo
  // fraudpheus
  B091HC53AR2: (msg) => msg.metadata?.event_payload?.source_user_id,
  // nemo
  B0BQFDMCL0H: (msg) => msg.metadata?.event_payload?.source_user_id, // dev
  // forge
  B0APKS1DZAQ: (msg) => msg.metadata?.event_payload?.source_user_id,
  // izie's pet
  B0AJHVBLHUN: (msg) => msg.metadata?.event_payload?.source_user_id,
  // heidi the helper (nephthys)
  B0BTRCXG41E: (msg) => msg.metadata?.event_payload?.source_user_id,
}

export default class ShowRealUser extends TautPlugin<typeof ShowRealUser> {
  static readonly id = 'ShowRealUser'
  static readonly pluginName = 'Show Real User'
  static readonly description =
    'Shows the user who sent a message via a bot like at-channel'
  static readonly authors = '<@U06UYA5GMB5>'
  static readonly defaultConfig = {
    enabled: true,
  }

  /** key: "channel:ts" -> sender, or null once we know the bot named none */
  private senders = new this.api.Cache<string | null>('relay_senders_v2', {
    ttl: 30 * 24 * 60 * 60 * 1000,
    maxSize: 5000,
  })
  /** failed lookups, otherwise every store update retries them */
  private failed = new Set<string>()
  private refreshTimer: ReturnType<typeof setTimeout> | null = null

  private relay(msg: RelayedMessage | undefined) {
    return msg?.bot_id ? RELAY_BOTS[msg.bot_id] : undefined
  }

  private validId(value: unknown): string | undefined {
    return typeof value === 'string' && USER_ID_RE.test(value)
      ? value
      : undefined
  }

  // the store keeps event_type but drops the payload, so fetch it ourselves
  private async lookUp(key: string) {
    const [channel, ts] = key.split(':')
    try {
      await this.senders.fetch(key, async () => {
        const res = await this.api.userAPI<{ messages?: RelayedMessage[] }>(
          'conversations.replies',
          {
            channel,
            ts,
            limit: '1',
            inclusive: 'true',
            include_all_metadata: 'true',
          },
          { rateLimitRetries: 3, signal: this.api.signal }
        )
        const found = res.messages?.find((msg) => msg.ts === ts)
        const relay = this.relay(found)
        return (relay && this.validId(relay(found as RelayedMessage))) ?? null
      })
    } catch (err) {
      this.failed.add(key)
      this.log('could not look up sender for', key, err)
      return
    }
    // a screenful resolves together, so repaint once they've settled
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      if (!this.api.signal.aborted) this.api.redux.refresh()
    }, 100)
  }

  /** a forwarded copy of a relayed message, re-credited to the real person */
  private asForwardedBy(att: SlackAttachment): SlackAttachment {
    if (!att?.channel_id || !att.ts) return att
    const botId = SERVICE_RE.exec(att.author_link ?? '')?.[1]
    if (!botId || !RELAY_BOTS[botId]) return att
    const user = this.senderOf(att.channel_id, att.ts)
    if (!user) return att
    const profile = this.api.members.getCachedMember(user)?.profile
    const forwarded = {
      ...att,
      author_id: user,
      author_name:
        profile?.display_name || profile?.real_name || att.author_name,
      author_icon: profile?.image_48 ?? att.author_icon,
      author_link: this.profileLink(att.author_link, user),
    }
    delete forwarded.author_subname
    return forwarded
  }

  /** the bot's own link, repointed at a person, keeping the workspace domain */
  private profileLink(link: string | undefined, user: string) {
    try {
      return `${new URL(link ?? '').origin}/team/${user}`
    } catch {
      return link
    }
  }

  /** the message as sent by the real person, once we know who that is */
  private fixed(
    msg: RelayedMessage | undefined,
    channel = msg?.channel,
    ts = msg?.ts
  ): RelayedMessage | undefined {
    if (!msg) return msg
    let out = msg
    const relay = this.relay(msg)
    if (relay) {
      const user =
        this.validId(relay(msg)) ??
        (channel && ts ? this.senderOf(channel, ts) : undefined)
      if (user)
        out = this.api.messages.modifyMessageObject(msg, { sentBy: user })
    }
    // a message can forward a relayed one without being relayed itself
    const attachments = out.attachments
    if (Array.isArray(attachments)) {
      const next = attachments.map((att) => this.asForwardedBy(att))
      if (next.some((att, i) => att !== attachments[i]))
        out = { ...out, attachments: next }
    }
    return out
  }

  private withBot(msg: RelayedMessage | undefined) {
    const bot = msg?.taut_bot_id
    if (!msg || msg.bot_id || typeof bot !== 'string') return msg
    const stored =
      typeof msg.channel === 'string' && msg.ts
        ? this.api.messages.getRawMessage(msg.channel, msg.ts)
        : undefined
    return {
      ...msg,
      bot_id: bot,
      ...(stored?.bot_profile && { bot_profile: stored.bot_profile }),
    }
  }

  /** the sender we know for a relayed message, looking it up if we don't */
  private senderOf(channel: string, ts: string): string | undefined {
    const key = `${channel}:${ts}`
    const known = this.senders.get(key)
    if (known !== undefined) return known ?? undefined
    // the cache dedups an in-flight lookup, so a repeat read costs nothing
    if (!this.failed.has(key)) void this.lookUp(key)
    return undefined
  }

  async start() {
    await this.senders.load()
    if (this.api.signal.aborted) return

    // messages nest a channel deep, so each channel's bucket gets mapped too
    this.api.redux.patchSlice<object>('messages', (channelId, bucket) => {
      if (!bucket || typeof bucket !== 'object') return bucket
      return this.api.redux.mapEntries<RelayedMessage>(bucket, (ts, msg) =>
        this.fixed(msg, channelId, ts)
      )
    })
    this.api.redux.refresh()

    for (const name of [
      'MessageWrapper',
      'ThreadRootGeneric',
      'ActivityItem',
    ]) {
      this.api.patchComponent<{ msg?: RelayedMessage }>(
        name,
        (Original) => (props) => {
          const version = this.api.redux.usePatchVersion()
          const msg = React.useMemo(
            () => this.fixed(props.msg),
            [props.msg, version]
          )
          return <Original {...props} msg={msg} />
        }
      )
    }

    // block kit stays the bot's, so its buttons keep working
    this.api.patchComponent<{ msg?: RelayedMessage }>(
      'Blocks',
      (Original) => (props) => (
        <Original {...props} msg={this.withBot(props.msg)} />
      )
    )

    // search keeps its own copies, which carry the bot's user id as the sender
    this.api.patchComponent<{ result?: SearchResult }>(
      'MessageListItem',
      (Original) => (props) => {
        const version = this.api.redux.usePatchVersion()
        const result = React.useMemo(() => {
          const found = props.result?.messages
          if (!found?.length) return props.result
          const fixed = found.map((msg) => this.fixed(msg) ?? msg)
          return fixed.some((msg, i) => msg !== found[i])
            ? { ...props.result, messages: fixed }
            : props.result
        }, [props.result, version])
        return <Original {...props} result={result} />
      }
    )

    this.log('Started')
  }
}
