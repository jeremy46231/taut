// Sends @channel and @here through at-channel where you can't ping yourself

import { TautPlugin } from '$taut'

const AT_CHANNEL_APP = 'A08FPGU02A2'
const AT_CHANNEL_USER = 'U08G06U8PS8'
const AT_CHANNEL_BOT = 'B08G06U6SJG'

type Op = { insert?: unknown; attributes?: { slackmention?: { id?: string } } }
type Delta = {
  ops?: Op[]
  concat(other: Delta): Delta
  constructor: new () => Delta & { insert(text: string): Delta }
}
type SendArgs = {
  channelId?: string
  delta?: Delta
  replyToTs?: string
  shouldBroadcast?: boolean
  dateScheduled?: unknown
  fileIds?: unknown[]
  pendingFileIds?: unknown[]
  slashCommandAppId?: string
  draftId?: string
  viewContext?: string
  inputRef?: Input
  [key: string]: unknown
}
type Input = {
  isEmpty(): boolean
  setContents(contents: { contents?: Op[] }): void
}
type Where = { channelId: string; viewContext?: string }
type Draft = { ops?: Op[]; [key: string]: unknown }
type Block = { type?: string; [key: string]: unknown }
type EditArgs = {
  channelId?: string
  ts?: string
  blocks?: Block[]
  [key: string]: unknown
}
type AutocompleteArgs = {
  channelId?: string
  isThread?: boolean
  enableBroadcastKeywords?: boolean
  [key: string]: unknown
}
type Channel = {
  id?: string
  is_channel?: boolean
  is_private?: boolean
  is_ext_shared?: boolean
}
type KeywordsFor = (state: unknown, channelId: string) => { id: string }[]
type Action = (payload: unknown) => unknown
type PendingSend = {
  delta: Delta
  draftId?: string
  draft?: Draft
  viewContext?: string
  /** at-channel pings in this channel whose sender is still being looked up */
  pings: number
  /** at-channel replied with an error or timed out (applies once `pings` is 0) */
  failing?: boolean
}

const SLASH_COMMAND_RE = /^[/／][^/／\s]/
/** how long after the command at-channel may take to ping, real-world is like half a second */
const PING_TIMEOUT = 10_000

export default class NativeAtChannel extends TautPlugin<
  typeof NativeAtChannel
> {
  static readonly id = 'NativeAtChannel'
  static readonly pluginName = 'Native At Channel'
  static readonly description =
    "Sends @channel and @here through at-channel where you can't ping yourself"
  static readonly authors = ['jeremy'] as const
  static readonly category = 'messageBox'
  static readonly hackClubOnly = true
  static readonly defaultConfig = {
    enabled: false,
  }

  /** "channel:ts" -> who sent that ping, or null */
  private senders = new this.api.Cache<string | null>('ping_senders', {
    ttl: 30 * 24 * 60 * 60 * 1000,
    maxSize: 5000,
  })
  private keywordsFor?: KeywordsFor
  /** drafts the composer set aside to send, which a relayed send must delete */
  private sending = new Map<string, Draft>()
  /** channel -> the send at-channel hasn't answered yet */
  private pendingSends = new Map<string, PendingSend>()
  private setLocalDraft?: Action
  private getInputProxy?: (where: Where) => Input | undefined
  private isInputRegistered?: (where: Where) => boolean
  /** client_token -> waiting for the modal a shortcut run with it opens */
  private views = new Map<string, (viewId: string) => void>()

  async start() {
    await this.senders.load()
    if (this.api.signal.aborted) return

    // only Slack's edit and delete checks see your pings as typed by you, nothing else patched
    this.api.messages.patchActionableMessage((msg) =>
      msg.channel && msg.ts && this.isOwnPing(msg.channel, msg.ts)
        ? this.api.messages.modifyMessageObject(msg, {
            sentBy: this.me(),
            typed: true,
          })
        : msg
    )

    // look up each ping's sender on arrival so the up arrow can edit it right away
    this.api.rtm.on('message', (event) => {
      const { bot_id, channel, ts } = event
      if (typeof channel !== 'string' || typeof ts !== 'string') return
      const pending = this.pendingSends.get(channel)
      if (bot_id === AT_CHANNEL_BOT && !event.is_ephemeral) {
        if (pending) pending.pings++
        this.api.messages
          .fetchMessageMetadata(channel, ts, this.api.signal)
          .catch(() => {})
          .then(() => {
            if (this.api.signal.aborted) return
            if (pending) pending.pings--
            if (this.senderOf(channel, ts) === this.me()) this.relayed(channel)
            else if (pending?.failing && !pending.pings)
              this.failed(channel, pending)
          })
      } else if (pending && event.is_ephemeral && this.isAtChannelBot(bot_id)) {
        // at-channel's ephemeral reply when it failed, sometimes after pinging
        if (/^:tw_warning:/.test(String(event.text ?? '')))
          this.giveUp(channel, pending)
      }
    })
    this.api
      .waitForExport<Action>(this.api.byMeta('setLocalDraft'))
      .then((fn) => {
        this.setLocalDraft = fn
      })
    this.api
      .waitForExport<(where: Where) => Input | undefined>(
        this.api.byName('getInputProxy')
      )
      .then((fn) => {
        this.getInputProxy = fn
      })
    this.api
      .waitForExport<(where: Where) => boolean>(
        this.api.byName('isInputRegistered')
      )
      .then((fn) => {
        this.isInputRegistered = fn
      })

    this.api
      .waitForExport<KeywordsFor>(
        this.api.byName('getBroadcastKeywordsForUser')
      )
      .then((fn) => {
        this.keywordsFor = fn
      })

    // Slack leaves @channel and @here out of the @ menu when you can't use them
    this.api.redux.patchThunk(
      'autocompleteMembers',
      (original) =>
        (args: AutocompleteArgs, ...rest: unknown[]) =>
        async (dispatch: (action: unknown) => unknown) => {
          const { channelId } = args ?? {}
          if (
            !channelId ||
            args.enableBroadcastKeywords === false ||
            args.isThread ||
            args.includeAllBroadcastKeywords
          )
            return dispatch(original(args, ...rest))
          const relayable = new Set<string>()
          for (const type of ['channel', 'here'] as const)
            if (await this.relayableNow(channelId, type))
              relayable.add(`BK${type}`)
          if (!relayable.size) return dispatch(original(args, ...rest))
          const state = this.api.redux.getRawState()
          const offered = new Set([
            ...relayable,
            ...(this.keywordsFor?.(state, channelId) ?? []).map((k) => k.id),
          ])
          // the full list brings @everyone too, so keep only what Slack or at-channel can send
          const only = (results: unknown): unknown => {
            if (!Array.isArray(results)) return results
            const { promise } = results as { promise?: Promise<unknown> }
            const kept = results.filter(
              (r) => !r?.item?.is_broadcast_keyword || offered.has(r.id)
            )
            return promise
              ? Object.assign(kept, { promise: promise.then(only) })
              : kept
          }
          return only(
            await dispatch(
              original({ ...args, includeAllBroadcastKeywords: true }, ...rest)
            )
          )
        }
    )

    // a message starting with a slash is treated as a slash command by this thunk
    this.api.redux.patchThunk(
      'prepareAndSendMessage',
      (original) =>
        (args: SendArgs, ...rest: unknown[]) =>
        async (dispatch: (action: unknown) => unknown) => {
          const relayed = await this.viaAtChannel(args)
          if (!relayed?.channelId || !args.delta)
            return dispatch(original(args, ...rest))
          const { channelId } = relayed
          const pending: PendingSend = {
            delta: args.delta,
            draftId: args.draftId,
            draft: this.sending.get(args.draftId ?? ''),
            viewContext: args.viewContext,
            pings: 0,
          }
          this.sending.delete(args.draftId ?? '')
          this.pendingSends.set(channelId, pending)
          let result: unknown
          try {
            result = await dispatch(original(relayed, ...rest))
          } catch (err) {
            if (this.api.signal.aborted) throw err
            // at-channel's ping or error was already handled, so ignore the send's late failure
            if (this.pendingSends.get(channelId) !== pending) return
            // Slack puts it back itself if the composer it sent from is still empty
            if (args.inputRef) this.pendingSends.delete(channelId)
            else this.failed(channelId, pending)
            throw err
          }
          this.later(PING_TIMEOUT, () => this.giveUp(channelId, pending))
          return result
        }
    )
    // the composer drops its draft locally just before sending, so hold on to it briefly
    this.api.redux.patchThunk(
      'clearDrafts',
      (original) =>
        (
          args: { ids?: string[]; syncDelete?: boolean },
          ...rest: unknown[]
        ) => {
          if (args?.syncDelete === false) {
            const drafts = this.api.redux.getRawState()?.drafts?.unifiedDrafts
            for (const id of args.ids ?? []) {
              if (!drafts?.[id]) continue
              this.sending.set(id, drafts[id])
              this.later(30_000, () => this.sending.delete(id))
            }
          }
          return original(args, ...rest)
        }
    )

    this.api.redux.patchThunk(
      'chatDeleteFetcher',
      (original) =>
        (args: { channel?: string; ts?: string }, ...rest: unknown[]) => {
          const { channel, ts } = args ?? {}
          // our own at-channel ping goes through at-channel's "Delete this message" shortcut
          return channel && ts && this.isOwnPing(channel, ts)
            ? () => this.runShortcut('8584016357748', channel, ts)
            : original(args, ...rest)
        }
    )

    this.api.redux.patchThunk(
      'commitMessageEdit',
      (original) =>
        (args: EditArgs, ...rest: unknown[]) => {
          const { channelId: channel, ts, blocks } = args ?? {}
          return channel && ts && blocks && this.isOwnPing(channel, ts)
            ? () => this.editPing(channel, ts, blocks)
            : original(args, ...rest)
        }
    )
    this.api.rtm.on('view_opened', (event) => {
      const token = event.client_token
      const viewId = event.view_id
      if (typeof token !== 'string' || typeof viewId !== 'string') return
      this.views.get(token)?.(viewId)
    })
  }

  /** the ping went out, clean up */
  private relayed(channelId: string) {
    const pending = this.pendingSends.get(channelId)
    if (!pending) return
    this.pendingSends.delete(channelId)
    if (!pending.draft) return
    this.api.redux
      .dispatchThunk('deleteDraftApi', {
        draft: pending.draft,
        reason: 'NativeAtChannel',
      })
      .catch((err) => this.log('could not delete the draft', err))
  }

  /** at-channel refused or never pinged, which a ping still being looked up can overrule */
  private giveUp(channelId: string, pending: PendingSend) {
    pending.failing = true
    if (!pending.pings) this.failed(channelId, pending)
  }

  /** at-channel didn't send it, so like a failed command it goes back in the composer if that's still empty */
  private failed(channelId: string, pending: PendingSend) {
    if (this.pendingSends.get(channelId) !== pending || this.api.signal.aborted)
      return
    this.pendingSends.delete(channelId)
    const restored = this.restore(channelId, pending)
    this.log('at-channel did not send in', channelId, { restored })
  }

  /** put the send back in the composer, only if it's empty */
  private restore(channelId: string, pending: PendingSend): boolean {
    const store = this.api.redux.getStore()
    if (!store || !this.setLocalDraft || !this.getInputProxy) return false
    const { viewContext } = pending
    const { ops } = pending.delta
    const input = this.getInputProxy({ viewContext, channelId })
    if (input) {
      if (!input.isEmpty()) return false
      input.setContents({ contents: ops })
    } else {
      // composer not rendered, look at the draft
      const drafts = this.api.redux.getRawState()?.drafts?.unifiedDrafts
      const current: Draft | undefined = drafts?.[pending.draftId ?? '']
      const typed = current?.ops?.some(
        (op) => typeof op.insert !== 'string' || op.insert.trim()
      )
      if (typed || !pending.draft || this.isInputRegistered?.({ channelId }))
        return false
    }
    if (pending.draft)
      store.dispatch(this.setLocalDraft({ ...pending.draft, ops }))
    return true
  }

  /** runs `fn` after `ms` unless the plugin has stopped */
  private later(ms: number, fn: () => void) {
    setTimeout(() => {
      if (!this.api.signal.aborted) fn()
    }, ms)
  }

  private isAtChannelBot(botId: unknown): boolean {
    if (typeof botId !== 'string') return false
    const bot = this.api.redux.getRawState()?.bots?.[botId]
    return botId === AT_CHANNEL_BOT || bot?.app_id === AT_CHANNEL_APP
  }

  /** the same send as an at-channel command, when Slack would refuse it */
  private async viaAtChannel(args: SendArgs): Promise<SendArgs | undefined> {
    const { channelId, delta } = args
    if (!channelId || !delta?.ops) return
    // at-channel pings top-level only, and a command carries no files
    if (args.replyToTs || args.shouldBroadcast || args.dateScheduled) return
    if (args.fileIds?.length || args.pendingFileIds?.length) return
    // already a command, which Slack runs as typed
    const first = delta.ops[0]?.insert
    if (args.slashCommandAppId || SLASH_COMMAND_RE.test(String(first))) return

    const used = new Set(
      delta.ops.map((op) => op.attributes?.slackmention?.id ?? '')
    )
    const type = used.has('BKchannel')
      ? 'channel'
      : used.has('BKhere')
        ? 'here'
        : undefined
    if (!type) return

    if (!(await this.relayableNow(channelId, type))) return

    const command = new delta.constructor().insert(`/${type} `)
    this.log(`sending as /${type} in`, channelId)
    return {
      ...args,
      delta: command.concat(delta),
      slashCommandAppId: AT_CHANNEL_APP,
    }
  }

  /** whether Slack would refuse this broadcast but at-channel could send it, undefined until membership is known */
  private relayable(
    channelId: string,
    type: 'channel' | 'here'
  ): boolean | undefined {
    if (!this.keywordsFor) return false
    const state = this.api.redux.getRawState()
    if (!state?.slashCommand?.commands?.[`${AT_CHANNEL_APP}-/${type}`])
      return false
    if (this.keywordsFor(state, channelId).some((k) => k.id === `BK${type}`))
      return false

    const channel: Channel | undefined = state.channels?.[channelId]
    if (!channel?.is_channel || channel.is_ext_shared) return false
    if (!channel.is_private) return true
    // at-channel only hears commands in private channels it's in
    const known = state.membership?.[channelId]?.[AT_CHANNEL_USER]
    if (known?.isKnown) return !!known.isMember
    this.fetchMembership(channelId)
    return undefined
  }

  /** relayable, looking up at-channel's membership first if need be */
  private async relayableNow(
    channelId: string,
    type: 'channel' | 'here'
  ): Promise<boolean> {
    const known = this.relayable(channelId, type)
    if (known !== undefined) return known
    await this.fetchMembership(channelId)
    return !!this.relayable(channelId, type)
  }

  /** Slack's membership lookup, which remembers the answer in the store, given up on after 5s */
  private fetchMembership(channelId: string) {
    const lookup = this.api.redux
      .dispatchThunk('getChannelMembershipInfoForUsers', {
        channelId,
        userIds: [AT_CHANNEL_USER],
      })
      .catch((err) => this.log('membership lookup failed', err))
    return Promise.race([
      lookup,
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ])
  }

  /** whether at-channel posted this for you */
  private isOwnPing(channel: string, ts: string): boolean {
    const stored = this.api.messages.getRawMessage(channel, ts)
    if (stored?.bot_id !== AT_CHANNEL_BOT) return false
    const sender = this.senderOf(channel, ts)
    return !!sender && sender === this.me()
  }

  private me(): string {
    return this.api.members.getCurrentMemberId() ?? ''
  }

  /** who at-channel says sent a ping, undefined until that's known */
  private senderOf(channel: string, ts: string): string | null | undefined {
    const key = `${channel}:${ts}`
    const known = this.senders.get(key)
    if (known !== undefined) return known
    const metadata = this.api.messages.getMessageMetadata(channel, ts)
    if (metadata === undefined) return undefined
    const sender = metadata?.event_payload?.source_user_id
    const found =
      typeof sender === 'string' && /^[UW][A-Z0-9]+$/.test(sender)
        ? sender
        : null
    this.senders.set(key, found)
    return found
  }

  /** run one of at-channel's message shortcuts on a message, as you */
  private runShortcut(
    actionId: string,
    channelId: string,
    messageTs: string,
    clientToken = `web-${Date.now()}`
  ) {
    this.log('running at-channel shortcut', actionId, 'on', messageTs)
    return this.api.redux.dispatchThunk('executeAppAction', {
      appId: AT_CHANNEL_APP,
      actionId,
      channelId,
      messageTs,
      clientToken,
    })
  }

  /** Slack only draws modals whose client_token it made, so this edit modal never shows */
  private async editPing(channelId: string, ts: string, blocks: Block[]) {
    const richText = blocks.find((block) => block.type === 'rich_text')
    if (!richText) throw new Error('Nothing to edit the ping to')
    const clientToken = `web-${Date.now()}`
    const opened = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.views.delete(clientToken)
        reject(new Error('at-channel did not open its edit modal'))
      }, 10_000)
      this.views.set(clientToken, (viewId) => {
        clearTimeout(timer)
        this.views.delete(clientToken)
        resolve(viewId)
      })
    })
    // at-channel's "Edit this message" shortcut
    await this.runShortcut('8573908295398', channelId, ts, clientToken)
    const viewId = await opened
    await this.api.redux.dispatchThunk('submitView', {
      viewId,
      viewState: {
        values: {
          message: {
            message_input: {
              type: 'rich_text_input',
              rich_text_value: richText,
            },
          },
        },
      },
    })
    return { ok: true }
  }
}
