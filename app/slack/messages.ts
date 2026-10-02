import { userAPI } from '../api/userAPI'
import {
  getPatchVersion,
  getRawState,
  type MapEntry,
  mapEntries,
  patchSlice,
  patchThunk,
  reduxPromise,
  refreshState,
  subscribeStore,
} from './redux'
import { byName, patchFunctionExport, waitForExport } from './webpack'

export type SlackBotIcons = {
  image_36?: string
  image_48?: string
  image_72?: string
  emoji?: string
}

export type SlackBot = {
  id?: string
  name?: string
  app_id?: string
  user_id?: string
  deleted?: boolean
  icons?: SlackBotIcons
  [key: string]: unknown
}

export type SlackMessage = {
  channel?: string
  ts?: string
  user?: string
  bot_id?: string
  app_id?: string
  username?: string
  icons?: SlackBotIcons
  bot_profile?: SlackBot
  subtype?: string
  attachments?: SlackAttachment[]
  [key: string]: unknown
}

/** one row of the activity feed */
export type SlackActivityItem = {
  type?: string
  channelId?: string
  messageTs?: string
  [key: string]: unknown
}

/** forwarded message data */
export type SlackAttachment = {
  author_id?: string
  author_name?: string
  /** the name the forwarded message was posted under, when it overrode one */
  author_subname?: string
  author_icon?: string
  author_link?: string
  channel_id?: string
  ts?: string
  [key: string]: unknown
}

export const getMessageBotId = (
  msg: SlackMessage | undefined
): string | undefined =>
  msg?.bot_id ??
  msg?.bot_profile?.id ??
  (msg?.taut_bot_id as string | undefined)

export function getRawMessage(
  channel: string,
  ts: string
): SlackMessage | undefined {
  return getRawState()?.messages?.[channel]?.[ts]
}

/** the original stored version of a rendered message, before Taut's patches */
export const asRawMessage = (
  msg: SlackMessage | undefined
): SlackMessage | undefined =>
  (typeof msg?.channel === 'string' &&
    msg.ts &&
    getRawMessage(msg.channel, msg.ts)) ||
  msg

/** rewrites one run of text a message shows */
export type TextTransform = (text: string) => string

/** where a message keeps text it shows, on the stored copy and on a search result */
const MESSAGE_TEXT_FIELDS = [
  'text',
  'blocks',
  'blocksProcessed',
  'attachments',
  'extracts',
  'blocks_extracts',
  'blocks_extracts_typed',
] as const
/** keys whose string is drawn as text, anywhere in those fields */
const TEXT_KEYS = new Set(['text', 'fallback', 'title', 'pretext', 'footer'])
/** objects whose `text` is literal, where elsewhere it is mrkdwn */
const LITERAL_TYPES = new Set(['text', 'link', 'plain_text'])
/** mrkdwn that is markup rather than words: `<target|label>` and `:emoji:` */
const MRKDWN_TOKEN = /<([^<>|]*)(?:\|([^<>]*))?>|:[\w+'-]+:/g

/** `transform` applied to the words of a mrkdwn string, its markup left alone */
function transformMrkdwn(text: string, transform: TextTransform): string {
  let out = ''
  let last = 0
  for (const match of text.matchAll(MRKDWN_TOKEN)) {
    const [token, target, label] = match
    out += transform(text.slice(last, match.index))
    // a link shows its label, while mentions keep a name in theirs
    out +=
      label !== undefined && !/^[@#!]/.test(target)
        ? `<${target}|${transform(label)}>`
        : token
    last = match.index + token.length
  }
  return last === 0 ? transform(text) : out + transform(text.slice(last))
}

/** the same structure with its text transformed, or `value` itself if none changed */
function transformDeep(value: unknown, transform: TextTransform): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const out = transformDeep(item, transform)
      if (out !== item) changed = true
      return out
    })
    return changed ? next : value
  }
  if (!value || typeof value !== 'object') return value
  const literal = LITERAL_TYPES.has(
    (value as { type?: unknown }).type as string
  )
  let next: Record<string, unknown> | null = null
  for (const [key, item] of Object.entries(value)) {
    let out: unknown
    if (TEXT_KEYS.has(key) && typeof item === 'string')
      out = literal ? transform(item) : transformMrkdwn(item, transform)
    else out = transformDeep(item, transform)
    if (out === item) continue
    next ??= { ...value }
    next[key] = out
  }
  return next ?? value
}

/** `message` with every text it shows transformed, or `message` itself if none changed */
function withMessageText<T extends object>(
  message: T,
  transform: TextTransform
): T {
  let next: Record<string, unknown> | null = null
  for (const field of MESSAGE_TEXT_FIELDS) {
    const value = (message as Record<string, unknown>)[field]
    const out =
      typeof value === 'string'
        ? transformMrkdwn(value, transform)
        : transformDeep(value, transform)
    if (out === value) continue
    next ??= { ...(message as Record<string, unknown>) }
    next[field] = out
  }
  return (next as T | null) ?? message
}

/** an edit this soon after posting is the bot finishing its own message */
const FINISHING_EDIT_SECONDS = 3

type SectionBlock = { type?: string; text?: { type?: string; text?: string } }

/** the mrkdwn of blocks that are only mrkdwn sections, else undefined */
function sectionsMrkdwn(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks) || !blocks.length) return undefined
  const texts: string[] = []
  for (const block of blocks as SectionBlock[]) {
    const keys = Object.keys(block ?? {}).filter(
      (key) => key !== 'block_id' && key !== 'blockId'
    )
    if (
      block?.type !== 'section' ||
      block.text?.type !== 'mrkdwn' ||
      typeof block.text.text !== 'string' ||
      keys.some((key) => key !== 'type' && key !== 'text')
    )
      return undefined
    texts.push(block.text.text)
  }
  return texts.join('\n')
}

export function modifyMessageObject(
  message: SlackMessage,
  edits: {
    /** credit the message to this member, dropping every trace of the bot, except taut_bot_id */
    sentBy?: string
    /** turn mrkdwn-only sections into composer-style text, which Slack's edit check and editor accept */
    typed?: boolean
  }
): SlackMessage {
  const next: SlackMessage = { ...message }
  if (edits.sentBy !== undefined) {
    next.user = edits.sentBy
    const bot = getMessageBotId(message)
    if (bot) next.taut_bot_id = bot
    // Slack tests some of these with `in`, so delete rather than blank them
    for (const key of [
      'bot_id',
      'app_id',
      'username',
      'icons',
      'bot_profile',
      'display_as_bot',
    ] as const)
      delete next[key]
    if (next.subtype === 'bot_message') delete next.subtype
    // Slack never shows "(edited)" on a bot's message, so hide a relay's own quick update
    const edited = (next.edited as { ts?: string } | undefined)?.ts
    if (edited && Number(edited) - Number(next.ts) < FINISHING_EDIT_SECONDS)
      delete next.edited
  }
  if (edits.typed) {
    const text = sectionsMrkdwn(next.blocks)
    if (text !== undefined) {
      next.text = text
      delete next.blocks
      delete next.blocksProcessed
    }
  }
  return next
}

/** rewrites a message as Slack's edit and delete code reads it */
export type ActionableTransform = (message: SlackMessage) => SlackMessage

const actionableTransforms = new Set<ActionableTransform>()
let actionableMemo = new WeakMap<object, SlackMessage>()
let actionableVersion = -1

/** `message` through every actionable transform, the same object while nothing changes */
function asActionable<T>(message: T): T {
  if (!actionableTransforms.size || !message || typeof message !== 'object')
    return message
  if (actionableVersion !== getPatchVersion()) {
    actionableVersion = getPatchVersion()
    actionableMemo = new WeakMap()
  }
  const known = actionableMemo.get(message)
  if (known) return known as T
  let out = message as SlackMessage
  for (const transform of actionableTransforms) {
    try {
      out = transform(out) ?? out
    } catch (err) {
      console.error('[Taut] Actionable message transform failed:', err)
    }
  }
  actionableMemo.set(message, out)
  return out as T
}

/** for Slack's edit and delete checks, the up arrow and the editor, never what it draws */
export function patchActionableMessage(
  transform: ActionableTransform
): () => void {
  actionableTransforms.add(transform)
  actionableMemo = new WeakMap()
  return () => {
    actionableTransforms.delete(transform)
    actionableMemo = new WeakMap()
  }
}

// Slack calls these through their module's exports, so a load-time wrap catches every caller
patchFunctionExport(
  byName('canEditMessage'),
  (original) =>
    function canEditMessage(
      state: unknown,
      memberId: unknown,
      message: unknown,
      ...rest: unknown[]
    ) {
      return original(state, memberId, asActionable(message), ...rest)
    }
)
patchFunctionExport(
  byName('canDeleteMessageHelper'),
  (original) =>
    function canDeleteMessageHelper(
      state: unknown,
      args: { message?: SlackMessage } | undefined,
      ...rest: unknown[]
    ) {
      return original(
        state,
        args?.message ? { ...args, message: asActionable(args.message) } : args,
        ...rest
      )
    }
)
// the up arrow edits the newest message this returns
patchFunctionExport(
  byName('getLastMessageByMember'),
  (original) =>
    function getLastMessageByMember(
      messages: SlackMessage[],
      memberId: unknown,
      ...rest: unknown[]
    ) {
      if (!actionableTransforms.size || !Array.isArray(messages))
        return original(messages, memberId, ...rest)
      const views = messages.map(asActionable)
      const found = original(views, memberId, ...rest)
      // hand back Slack's object, the checks after it see the view anyway
      const index = views.indexOf(found)
      return index === -1 ? found : messages[index]
    }
)
// what the editor opens with
patchFunctionExport(
  byName('getDeltaForMessageObject'),
  (original) =>
    function getDeltaForMessageObject(
      state: unknown,
      message: unknown,
      ...rest: unknown[]
    ) {
      return original(state, asActionable(message), ...rest)
    }
)

/** what a message records about itself for apps, which the store keeps only the type of */
export type SlackMessageMetadata = {
  event_type?: string
  event_payload?: Record<string, unknown>
}

const metadataKnown = new Map<string, SlackMessageMetadata | null>()
type MetadataLookup = {
  promise: Promise<SlackMessageMetadata | null>
  controller: AbortController
  /** callers still waiting, the request stops once each has aborted */
  callers: number
}
const metadataLookups = new Map<string, MetadataLookup>()
const metadataFailed = new Set<string>()
let metadataRepaint: ReturnType<typeof setTimeout> | undefined

function lookUpMetadata(
  key: string,
  channel: string,
  ts: string
): MetadataLookup {
  const controller = new AbortController()
  // only conversations.replies returns the payload, and for any message
  const promise = userAPI<{ messages?: SlackMessage[] }>(
    'conversations.replies',
    {
      channel,
      ts,
      limit: '1',
      inclusive: 'true',
      include_all_metadata: 'true',
    },
    { rateLimitRetries: 3, signal: controller.signal }
  )
    .then((res) => {
      const found = res.messages?.find((msg) => msg.ts === ts)
      const metadata = (found?.metadata as SlackMessageMetadata) ?? null
      metadataKnown.set(key, metadata)
      clearTimeout(metadataRepaint)
      metadataRepaint = setTimeout(refreshState, 100)
      return metadata
    })
    .catch((err) => {
      // or every read would ask again
      if (!controller.signal.aborted) metadataFailed.add(key)
      throw err
    })
    .finally(() => {
      if (metadataLookups.get(key) === lookup) metadataLookups.delete(key)
    })
  const lookup: MetadataLookup = { promise, controller, callers: 0 }
  metadataLookups.set(key, lookup)
  return lookup
}

/** includes `event_payload`, null if none, looked up once with a state refresh after each burst */
export function fetchMessageMetadata(
  channel: string,
  ts: string,
  signal?: AbortSignal
): Promise<SlackMessageMetadata | null> {
  const key = `${channel}:${ts}`
  const known = metadataKnown.get(key)
  if (known !== undefined) return Promise.resolve(known)
  // conversations.replies can't find them
  if (getRawMessage(channel, ts)?.is_ephemeral) return Promise.resolve(null)
  if (signal?.aborted) return Promise.reject(signal.reason)
  const lookup = metadataLookups.get(key) ?? lookUpMetadata(key, channel, ts)
  lookup.callers++
  if (!signal) return lookup.promise
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason)
      if (--lookup.callers) return
      if (metadataLookups.get(key) === lookup) metadataLookups.delete(key)
      lookup.controller.abort(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    lookup.promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** null if it has none, undefined while it's looked up (a state refresh follows) or after a failed lookup */
export function getMessageMetadata(
  channel: string,
  ts: string,
  signal?: AbortSignal
): SlackMessageMetadata | null | undefined {
  const key = `${channel}:${ts}`
  const known = metadataKnown.get(key)
  if (known !== undefined || metadataFailed.has(key)) return known
  if (getRawMessage(channel, ts)?.is_ephemeral) return null
  fetchMessageMetadata(channel, ts, signal).catch((err) => {
    if (!signal?.aborted)
      console.warn('[Taut] Could not look up metadata for', key, err)
  })
  return undefined
}

type HistorySlice = {
  timestamps?: string[]
  start?: string
  end?: string
}
type ChannelHistory = {
  slices?: HistorySlice[]
  /** whether the oldest slice includes the conversation's first message */
  reachedStart?: boolean
  /** whether the newest slice includes the latest message */
  reachedEnd?: boolean
}

const historyKeyChannel = (key: string): string => key.split('-')[0]
const historyKeyThread = (key: string): string | undefined =>
  key.includes('-') ? key.slice(key.indexOf('-') + 1) : undefined

function inHistory(msg: SlackMessage, thread: string | undefined): boolean {
  const parent = typeof msg.thread_ts === 'string' ? msg.thread_ts : undefined
  if (thread !== undefined) return parent === thread
  // in the channel itself a reply only shows when it was also broadcast
  return (
    parent === undefined ||
    parent === msg.ts ||
    msg.subtype === 'thread_broadcast'
  )
}

function withTimestamps(
  history: ChannelHistory,
  added: string[]
): HistorySlice[] {
  const slices = history.slices ?? []
  const last = slices.length - 1
  let changed = false
  const next = slices.map((slice, position) => {
    const { timestamps, start, end } = slice
    if (!Array.isArray(timestamps)) return slice
    const covers = (ts: string) =>
      (start === undefined ||
        ts >= start ||
        (position === 0 && history.reachedStart === true)) &&
      (end === undefined ||
        ts <= end ||
        (position === last && history.reachedEnd === true))
    const missing = added.filter((ts) => covers(ts) && !timestamps.includes(ts))
    if (!missing.length) return slice
    changed = true
    // slack timestamps are fixed-width, so they sort as plain strings
    return { ...slice, timestamps: [...timestamps, ...missing].sort() }
  })
  return changed ? next : slices
}

export function injectMessages(
  getMessages: () => Iterable<SlackMessage>
): () => void {
  let indexedAt = -1
  let byChannel = new Map<string, Map<string, SlackMessage>>()

  const index = () => {
    if (indexedAt === getPatchVersion()) return byChannel
    indexedAt = getPatchVersion()
    byChannel = new Map()
    for (const msg of getMessages()) {
      if (typeof msg?.channel !== 'string' || typeof msg.ts !== 'string')
        continue
      let bucket = byChannel.get(msg.channel)
      if (!bucket) {
        bucket = new Map()
        byChannel.set(msg.channel, bucket)
      }
      bucket.set(msg.ts, msg)
    }
    return byChannel
  }

  const unpatchMessages = patchSlice<object>(
    'messages',
    (channel, bucket) => {
      const injected = index().get(channel)
      if (!injected?.size) return bucket
      return mapEntries<SlackMessage>(
        bucket ?? {},
        (ts, msg) => injected.get(ts) ?? msg,
        () => injected.keys()
      )
    },
    () => index().keys()
  )

  const unpatchHistory = patchSlice<ChannelHistory>(
    'channelHistory',
    (key, entry) => {
      const slices = entry?.slices
      if (!entry || !Array.isArray(slices)) return entry
      const injected = index().get(historyKeyChannel(key))
      if (!injected?.size) return entry
      const thread = historyKeyThread(key)
      const added = [...injected.values()]
        .filter((msg) => inHistory(msg, thread))
        .map((msg) => msg.ts as string)
      if (!added.length) return entry
      const next = withTimestamps(entry, added)
      return next === slices ? entry : { ...entry, slices: next }
    }
  )

  return () => {
    unpatchMessages()
    unpatchHistory()
  }
}

/** `value` with `fn` applied at `path` (`*` = every key), copied only where something changed */
function mapAt(
  value: unknown,
  path: readonly string[],
  fn: (item: object) => object
): unknown {
  if (!value || typeof value !== 'object') return value
  if (!path.length) return fn(value)
  const [head, ...rest] = path
  const keys = head === '*' ? Object.keys(value) : [head]
  let next: Record<string, unknown> | unknown[] | null = null
  for (const key of keys) {
    const item = (value as Record<string, unknown>)[key]
    const out = mapAt(item, rest, fn)
    if (out === item) continue
    next ??= Array.isArray(value) ? [...value] : { ...value }
    ;(next as Record<string, unknown>)[key] = out
  }
  return next ?? value
}

/** the messages open in an editor, as `channel:ts` */
function editingMessages(state: any): Set<string> {
  const windows = state?.messageEditWindow
  const keys = new Set<string>()
  if (!windows || typeof windows !== 'object') return keys
  for (const edit of Object.values<any>(windows))
    if (edit?.channelId && edit.ts) keys.add(`${edit.channelId}:${edit.ts}`)
  return keys
}

/** every message Slack shows, except one open in an editor so the edit starts from the real text */
export function patchMessageText(transform: TextTransform): () => void {
  const withText = <T extends object>(message: T): T =>
    withMessageText(message, transform)

  // opening an editor changes neither the slice nor the version, so refresh before React renders it
  let editing = new Set<string>()
  let editWindows: unknown
  const stopWatching = subscribeStore(() => {
    const windows = getRawState()?.messageEditWindow
    if (windows === editWindows) return
    editWindows = windows
    editing = editingMessages(getRawState())
    refreshState()
  })

  // one mapper per channel for the patch's life, so each keeps its memo
  const byChannel = new Map<string, MapEntry<SlackMessage>>()
  const mapperFor = (channel: string) => {
    let mapper = byChannel.get(channel)
    if (!mapper) {
      mapper = (ts, msg) =>
        msg && !editing.has(`${channel}:${ts}`) ? withText(msg) : msg
      byChannel.set(channel, mapper)
    }
    return mapper
  }
  const unpatchMessages = patchSlice<object>('messages', (channel, bucket) =>
    bucket && typeof bucket === 'object'
      ? mapEntries(bucket, mapperFor(channel))
      : bucket
  )

  // keyed by search instance ("main"), each holding a whole API response
  const searchMessages = [
    'response',
    'results',
    'messages',
    'items',
    '*',
    '*',
    'messages',
    '*',
  ] as const
  const unpatchSearch = patchSlice<object>(
    'searchResults',
    (_instance, entry) =>
      mapAt(entry, searchMessages, withText) as object | undefined
  )

  // the "Recent messages" suggestions under the search box
  const unpatchSuggestions = patchThunk(
    'searchInline',
    (original) =>
      (...params) => {
        const thunk = original(...params)
        return (...args: unknown[]) =>
          Promise.resolve(thunk(...args)).then((response) =>
            mapAt(response, ['items', '*'], withText)
          )
      }
  )

  const unpatchNotifications = patchThunk(
    'showNotification',
    (original) => (args: { message?: SlackMessage }) =>
      original(
        args?.message ? { ...args, message: withText(args.message) } : args
      )
  )

  return () => {
    stopWatching()
    unpatchMessages()
    unpatchSearch()
    unpatchSuggestions()
    unpatchNotifications()
  }
}

type SenderDetails = (
  state: any,
  item: SlackActivityItem | undefined
) => { senderType?: string; senderId?: string } | undefined

export const messagesPromise = (async () => {
  const { useReduxState } = await reduxPromise
  // the activity view is a lazy chunk
  let readSender: SenderDetails | undefined
  waitForExport<SenderDetails>(byName('getSenderDetailsFromActivityItem')).then(
    (found) => {
      readSender = found
    }
  )

  function useActivityMessage(
    item: SlackActivityItem | undefined
  ): SlackMessage | undefined {
    const drawn = useReduxState<string | undefined>((state) => {
      const sender = readSender?.(state, item)
      return sender?.senderType === 'app' ? undefined : sender?.senderId
    })
    const msg =
      item?.channelId && item.messageTs
        ? getRawMessage(item.channelId, item.messageTs)
        : undefined
    return msg && { ...msg, user: drawn }
  }

  function useMessageBot(msg: SlackMessage | undefined): SlackBot | undefined {
    const botId = useReduxState(() => getMessageBotId(asRawMessage(msg)))
    const stored = useReduxState<SlackBot | undefined>((state) =>
      botId ? state.bots?.[botId] : undefined
    )
    if (!botId) return undefined
    return stored ?? asRawMessage(msg)?.bot_profile ?? { id: botId }
  }

  return {
    getRawMessage,
    asRawMessage,
    getMessageBotId,
    injectMessages,
    patchMessageText,
    modifyMessageObject,
    fetchMessageMetadata,
    getMessageMetadata,
    patchActionableMessage,
    useActivityMessage,
    useMessageBot,
  }
})()

export type MessagesAPI = Awaited<typeof messagesPromise>
