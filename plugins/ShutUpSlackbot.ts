// Marks Slackbot's "an app took over your slash command" DMs as read and silences them

import { type RtmEvent, TautPlugin } from '$taut'

type Notice = {
  channel?: unknown
  user?: unknown
  text?: unknown
  subtype?: unknown
  bot_id?: unknown
  app_id?: unknown
  thread_ts?: unknown
  ts?: unknown
}
type NotificationArgs = { message?: Notice; [key: string]: unknown }
type UnreadCounts = { unreadCnt?: number }

const SENDERS = new Set(['USLACKBOT', 'USLACK'])

const COMMAND_TAKEN_OVER = new RegExp(
  [
    '^Your workspace has been using `(/[^`]+)` to kick off certain actions with (.+)\\. ',
    'Recently,? (.+) was installed to (.+) with the same command\\. ',
    "Now,? when people enter `(/[^`]+)`, it(?:'|\u2019|&#39;)ll run the action set up by (.+)\\. ",
    'You can learn more about <https://slack\\.com/help/articles/201259356-Slash-commands-in-Slack\\|managing app installation settings> in the Help Cent(?:er|re)\\.$',
  ].join('')
)

function isCommandNotice(msg: Notice | undefined): boolean {
  if (!msg || typeof msg.text !== 'string') return false
  if (typeof msg.user !== 'string' || !SENDERS.has(msg.user)) return false
  if (typeof msg.channel !== 'string' || !msg.channel.startsWith('D'))
    return false
  // custom responses, reminders and apps posting as Slackbot all set one of these
  if (msg.subtype || msg.bot_id || msg.app_id) return false
  if (msg.thread_ts && msg.thread_ts !== msg.ts) return false
  const match = COMMAND_TAKEN_OVER.exec(msg.text)
  // the command is named twice and so is the new app, and they must agree
  return !!match && match[1] === match[5] && match[3] === match[6]
}

const isNewer = (ts: unknown, than: unknown): ts is string =>
  typeof ts === 'string' &&
  (typeof than !== 'string' || Number.parseFloat(ts) > Number.parseFloat(than))

export default class ShutUpSlackbot extends TautPlugin<typeof ShutUpSlackbot> {
  static readonly id = 'ShutUpSlackbot'
  static readonly pluginName = 'Shut Up Slackbot'
  static readonly description =
    'Marks Slackbot\'s "an app took over your slash command" DMs as read and silences them'
  static readonly authors = ['jeremy', 'rowan'] as const
  static readonly category = 'messages'
  static readonly defaultConfig = {
    enabled: true,
  }

  start() {
    this.api.redux.patchThunk(
      'showNotification',
      (original) => (args: NotificationArgs) =>
        original(
          isCommandNotice(args?.message)
            ? { ...args, message: undefined }
            : args
        )
    )

    // runs before Slack's reducer, so the store still holds the old unreads
    this.api.rtm.on('message', (event: RtmEvent) => {
      const { channel, ts } = event
      if (!isCommandNotice(event) || !channel || !ts) return
      if (!this.onlyNoticesUnread(channel, ts)) return
      // after the reducer has taken the message, or its unread count is added back
      setTimeout(() => this.markRead(channel, ts), 0)
    })

    this.catchUp()
    this.log('Started')
  }

  /** whether everything unread in the DM before `ts` is a notice too */
  private onlyNoticesUnread(channel: string, ts: string): boolean {
    const state = this.api.redux.getRawState()
    const unread =
      (state?.unreadChannelCounts?.[channel] as UnreadCounts | undefined)
        ?.unreadCnt ?? 0
    if (unread === 0) return true
    const cursor = state?.channelCursors?.[channel]
    const bucket = state?.messages?.[channel]
    if (!bucket) return false
    let notices = 0
    for (const key in bucket) {
      const msg = bucket[key] as Notice | undefined
      if (key === ts || !isNewer(msg?.ts, cursor)) continue
      if (!isCommandNotice(msg)) return false
      notices++
    }
    return notices >= unread
  }

  private markRead(channel: string, ts: string) {
    if (this.api.signal.aborted) return
    this.api.redux
      .dispatchThunk('markLastRead', {
        id: channel,
        ts,
        reason: 'taut-shut-up-slackbot',
        immediate: true,
      })
      .catch((err) => this.log('Could not mark a notice read', err))
  }

  /** notices that arrived while Slack was closed */
  private async catchUp() {
    let seen: unknown
    const dms = await this.api.redux
      .waitForState(
        () => {
          const state = this.api.redux.getRawState()
          // every dispatch checks, so only look through the channels when they change
          if (!state?.unreadChannelCounts || state.channels === seen) return
          seen = state.channels
          return this.slackbotDms()
        },
        AbortSignal.any([this.api.signal, AbortSignal.timeout(60_000)])
      )
      .catch(() => undefined)
    for (const [channel, cursor] of dms ?? []) {
      if (this.api.signal.aborted) return
      if (!cursor) continue
      try {
        const { messages = [], has_more } = await this.api.userAPI<{
          messages?: Notice[]
          has_more?: boolean
        }>(
          'conversations.history',
          { channel, oldest: cursor, limit: '100' },
          { signal: this.api.signal }
        )
        // more than 100 unreads, something might be important
        if (has_more) continue
        const unread = messages
          .map((msg) => ({ ...msg, channel }))
          .filter((msg) => isNewer(msg.ts, cursor))
        const latest = unread[0]?.ts // history is newest first
        if (typeof latest === 'string' && unread.every(isCommandNotice))
          this.markRead(channel, latest)
      } catch (err) {
        if (!this.api.signal.aborted)
          this.log('Could not check for missed notices', err)
      }
    }
  }

  /** Slackbot DMs with unreads, and where each was last read, once the store knows */
  private slackbotDms(): Map<string, string | undefined> | undefined {
    const state = this.api.redux.getRawState()
    if (!state?.channels || !state.unreadChannelCounts) return undefined
    const dms = new Map<string, string | undefined>()
    let any = false
    for (const id in state.channels) {
      const channel = state.channels[id]
      if (!channel?.is_im || !SENDERS.has(channel.user)) continue
      any = true
      const counts = state.unreadChannelCounts[id] as UnreadCounts | undefined
      if (counts?.unreadCnt) dms.set(id, state.channelCursors?.[id])
    }
    return any ? dms : undefined
  }
}
