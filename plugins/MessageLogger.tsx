import {
  type MenuTemplateItem,
  type RtmEvent,
  type SlackAttachment,
  type SlackMessage,
  TautPlugin,
  type TautPluginConfig,
} from '$taut'

type DeletedStyle = 'red' | 'opacity'
type IgnoreAnchorsMode = 'off' | 'lax' | 'strict'

interface MessageLoggerConfig extends TautPluginConfig {
  deletedStyle?: DeletedStyle
  ignoreSelf?: boolean
  ignoreAnchors?: IgnoreAnchorsMode
  collapseEdits?: boolean
  notifyOnDelete?: boolean
  notifyOnEdit?: boolean
  retentionDays?: number
  persistLogs?: boolean
}

type DiffOp = 'equal' | 'delete' | 'insert'
type DiffChunk = { op: DiffOp; text: string }

const DIFF_CACHE = new Map<string, DiffChunk[]>()
const MAX_DIFF_CACHE = 250

function computeWordDiff(oldStr: string, newStr: string): DiffChunk[] {
  if (oldStr === newStr) return [{ op: 'equal', text: oldStr }]
  const cacheKey = `${oldStr}\0${newStr}`
  const cached = DIFF_CACHE.get(cacheKey)
  if (cached) return cached

  const a = oldStr.match(/[^\s]+|\s+/g) || []
  const b = newStr.match(/[^\s]+|\s+/g) || []
  if (!a.length) {
    const res: DiffChunk[] = [{ op: 'insert', text: newStr }]
    DIFF_CACHE.set(cacheKey, res)
    return res
  }
  if (!b.length) {
    const res: DiffChunk[] = [{ op: 'delete', text: oldStr }]
    DIFF_CACHE.set(cacheKey, res)
    return res
  }

  let prefixEnd = 0
  const maxPrefix = Math.min(a.length, b.length)
  while (prefixEnd < maxPrefix && a[prefixEnd] === b[prefixEnd]) {
    prefixEnd++
  }

  let aSuffixEnd = a.length - 1
  let bSuffixEnd = b.length - 1
  while (
    aSuffixEnd >= prefixEnd &&
    bSuffixEnd >= prefixEnd &&
    a[aSuffixEnd] === b[bSuffixEnd]
  ) {
    aSuffixEnd--
    bSuffixEnd--
  }

  const prefixChunks: DiffChunk[] =
    prefixEnd > 0 ? [{ op: 'equal', text: a.slice(0, prefixEnd).join('') }] : []
  const suffixChunks: DiffChunk[] =
    aSuffixEnd < a.length - 1
      ? [{ op: 'equal', text: a.slice(aSuffixEnd + 1).join('') }]
      : []

  const midA = a.slice(prefixEnd, aSuffixEnd + 1)
  const midB = b.slice(prefixEnd, bSuffixEnd + 1)

  let midChunks: DiffChunk[] = []
  if (midA.length === 0 && midB.length > 0) {
    midChunks = [{ op: 'insert', text: midB.join('') }]
  } else if (midB.length === 0 && midA.length > 0) {
    midChunks = [{ op: 'delete', text: midA.join('') }]
  } else if (midA.length * midB.length > 200000) {
    midChunks = [
      { op: 'delete', text: midA.join('') },
      { op: 'insert', text: midB.join('') },
    ]
  } else {
    const n = midA.length
    const m = midB.length
    const dp = new Uint32Array((n + 1) * (m + 1))
    const stride = m + 1
    for (let i = 1; i <= n; i++) {
      const prevRow = (i - 1) * stride
      const currRow = i * stride
      const aWord = midA[i - 1]
      for (let j = 1; j <= m; j++) {
        if (aWord === midB[j - 1]) {
          dp[currRow + j] = dp[prevRow + (j - 1)] + 1
        } else {
          const up = dp[prevRow + j]
          const left = dp[currRow + (j - 1)]
          dp[currRow + j] = up > left ? up : left
        }
      }
    }
    const chunks: DiffChunk[] = []
    let i = n
    let j = m
    while (i > 0 || j > 0) {
      const currRow = i * stride
      const prevRow = (i - 1) * stride
      if (i > 0 && j > 0 && midA[i - 1] === midB[j - 1]) {
        chunks.unshift({ op: 'equal', text: midA[i - 1] })
        i--
        j--
      } else if (
        j > 0 &&
        (i === 0 || dp[currRow + (j - 1)] >= dp[prevRow + j])
      ) {
        chunks.unshift({ op: 'insert', text: midB[j - 1] })
        j--
      } else if (
        i > 0 &&
        (j === 0 || dp[currRow + (j - 1)] < dp[prevRow + j])
      ) {
        chunks.unshift({ op: 'delete', text: midA[i - 1] })
        i--
      }
    }
    midChunks = chunks
  }

  const combined = [...prefixChunks, ...midChunks, ...suffixChunks]
  const merged: DiffChunk[] = []
  for (const c of combined) {
    const last = merged[merged.length - 1]
    if (last && last.op === c.op) last.text += c.text
    else merged.push({ ...c })
  }

  if (DIFF_CACHE.size >= MAX_DIFF_CACHE) {
    const firstKey = DIFF_CACHE.keys().next().value
    if (firstKey) DIFF_CACHE.delete(firstKey)
  }
  DIFF_CACHE.set(cacheKey, merged)
  return merged
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type EditEntry = {
  oldText: string
  newText: string
  editedAt: number
}

type DeletedRecord = SlackMessage & {
  taut_deleted: true
  taut_deleted_at: number
}

type KnownMessage = {
  channel: string
  ts: string
  user?: string
  text?: string
  blocks?: unknown[]
  attachments?: SlackAttachment[]
  files?: unknown[]
  bot_id?: string
  taut_bot_id?: string
  app_id?: string
  metadata?: Record<string, unknown>
  thread_ts?: string
  reply_count?: number
  reply_users?: string[]
  latest_reply?: string
  [key: string]: unknown
}

type MenuFromTemplateProps = { template?: MenuTemplateItem[] }
type BlocksProps = {
  msg?: SlackMessage
  blocksContainerContext?: string
  streaming?: boolean
}

const MAX_KNOWN_MESSAGES = 2500
const MAX_DELETED_MESSAGES = 1000
const MAX_EDIT_LOGS = 1000

export default class MessageLogger extends TautPlugin {
  static readonly id = 'MessageLogger'
  static readonly pluginName = 'Message Logger'
  static readonly description = 'Temporarily logs deleted and edited messages'
  static readonly authors = '<@U078PH0GBEH>'
  static readonly defaultConfig = `
    "MessageLogger": {
      "enabled": true,
      "deletedStyle": "red",
      "ignoreSelf": true,
      "collapseEdits": false,
      "persistLogs": true,
      "retentionDays": 14
    }
  `

  private get options(): MessageLoggerConfig {
    return this.config as MessageLoggerConfig
  }

  private known = new Map<string, KnownMessage>()
  private edits = new Map<string, EditEntry[]>()
  private deleted = new Map<string, DeletedRecord>()

  private vanishedMessages = new Set<string>()
  private cleanMessages = new Set<string>()
  private hiddenEdits = new Set<string>()

  private isTemporarilyHidden = false

  private readonly MessageContext = React.createContext<
    SlackMessage | undefined
  >(undefined)

  private activeMenuMessage: { channel: string; ts: string } | null = null
  private menuTrackingCleanup: (() => void) | null = null
  private unpatchInject: (() => void) | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private purgeTimer: ReturnType<typeof setInterval> | null = null
  private keydownCleanup: (() => void) | null = null
  private fetchCleanup: (() => void) | null = null
  private xhrCleanup: (() => void) | null = null
  private lastNotificationTime = 0

  private keyOf(channel: string | undefined, ts: string): string {
    return `${channel || '*'}:${ts}`
  }

  private get currentChannelId(): string {
    const fromPath = location.pathname.match(
      /\/client\/[A-Z0-9]+\/([A-Z0-9]+)/
    )?.[1]
    if (fromPath) return fromPath
    try {
      const state = this.api.redux.getRawState()
      return state?.activeChannelId || state?.ui?.activeChannelId || ''
    } catch {
      return ''
    }
  }

  private collectUserIds(value: unknown, out: Set<string>, depth = 0): void {
    if (!value || depth > 5) return
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 40)) {
        this.collectUserIds(item, out, depth + 1)
      }
      return
    }
    if (typeof value !== 'object') return
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const val = (value as Record<string, unknown>)[key]
      const normalizedKey = key.replace(/[_-]/g, '').toLowerCase()
      if (
        typeof val === 'string' &&
        /^[UW][A-Z0-9]{6,}$/.test(val) &&
        (normalizedKey === 'userid' ||
          normalizedKey === 'selfuserid' ||
          normalizedKey === 'currentuserid' ||
          normalizedKey === 'autheduserid')
      ) {
        out.add(val)
      }
      if (typeof val === 'object') {
        this.collectUserIds(val, out, depth + 1)
      }
    }
  }

  private selfUserIdsCache = new Set<string>()
  private selfUserIdsExpiresAt = 0
  private selfDeletedTs = new Map<string, number>()
  private selfMessageTs = new Set<string>()

  private isSelfDeleted(ts?: string): boolean {
    if (!ts) return false
    const exp = this.selfDeletedTs.get(ts)
    if (!exp) return false
    if (Date.now() > exp) {
      this.selfDeletedTs.delete(ts)
      return false
    }
    return true
  }

  private markSelfDeleted(ts?: string): void {
    if (!ts) return
    this.selfDeletedTs.set(ts, Date.now() + 60000)
    if (this.selfDeletedTs.size > 500) {
      const first = this.selfDeletedTs.keys().next().value
      if (first) this.selfDeletedTs.delete(first)
    }
  }

  private isSelfMessage(ts?: string): boolean {
    if (!ts) return false
    return this.selfMessageTs.has(ts)
  }

  private markSelfMessage(ts?: string): void {
    if (!ts) return
    this.selfMessageTs.add(ts)
    if (this.selfMessageTs.size > 3000) {
      const first = this.selfMessageTs.keys().next().value
      if (first) this.selfMessageTs.delete(first)
    }
  }

  private get selfUserIds(): Set<string> {
    const now = Date.now()
    if (now < this.selfUserIdsExpiresAt && this.selfUserIdsCache.size > 0) {
      return this.selfUserIdsCache
    }
    this.selfUserIdsExpiresAt = now + 10000
    const ids = new Set<string>()

    try {
      const raw = localStorage.getItem('localConfig_v2')
      if (raw) {
        const parsed = JSON.parse(raw)
        this.collectUserIds(parsed, ids)
        if (parsed?.teams && typeof parsed.teams === 'object') {
          for (const t of Object.values(parsed.teams) as any[]) {
            if (typeof t?.user_id === 'string') ids.add(t.user_id)
          }
        }
      }
    } catch {}

    try {
      const tsObj = (window as any).TS
      if (tsObj) {
        if (typeof tsObj.boot_data?.user_id === 'string')
          ids.add(tsObj.boot_data.user_id)
        if (typeof tsObj.model?.user_id === 'string')
          ids.add(tsObj.model.user_id)
        if (typeof tsObj.model?.user?.id === 'string')
          ids.add(tsObj.model.user.id)
        this.collectUserIds(tsObj.boot_data, ids)
        this.collectUserIds(tsObj.model, ids)
      }
    } catch {}

    try {
      const state = this.api.redux.getRawState()
      if (typeof state?.activeUserId === 'string') ids.add(state.activeUserId)
      if (typeof state?.bootData?.user_id === 'string')
        ids.add(state.bootData.user_id)
      if (typeof state?.users?.self?.id === 'string')
        ids.add(state.users.self.id)
      if (typeof state?.auth?.user_id === 'string') ids.add(state.auth.user_id)
      if (state?.teams && typeof state.teams === 'object') {
        for (const t of Object.values(state.teams) as any[]) {
          if (typeof t?.user_id === 'string') ids.add(t.user_id)
        }
      }
      const current = this.api.members.getCurrentMemberId()
      if (current) ids.add(current)
    } catch {}

    for (const cachedId of this.selfUserIdsCache) {
      ids.add(cachedId)
    }

    this.selfUserIdsCache = ids
    return ids
  }

  private isSelfUser(userId?: string): boolean {
    if (!userId) return false
    if (this.selfUserIds.has(userId)) return true
    const current = this.currentUserId
    if (current && current === userId) return true
    return false
  }

  private purgeSelfMessage(channel: string | undefined, ts?: string): void {
    if (!ts) return
    const key = this.keyOf(channel, ts)
    const altKey = this.keyOf('', ts)
    this.deleted.delete(key)
    this.deleted.delete(altKey)
    this.edits.delete(key)
    this.edits.delete(altKey)
    this.vanishedMessages.delete(key)
    this.vanishedMessages.delete(altKey)
    this.cleanMessages.delete(key)
    this.cleanMessages.delete(altKey)
    this.hiddenEdits.delete(key)
    this.hiddenEdits.delete(altKey)
    this.known.delete(key)
    this.known.delete(altKey)
  }

  private get currentUserId(): string {
    const current = this.api.members.getCurrentMemberId()
    if (current) return current
    try {
      const state = this.api.redux.getRawState()
      return (
        state?.bootData?.user_id ||
        state?.activeUserId ||
        state?.users?.self?.id ||
        state?.auth?.user_id ||
        ''
      )
    } catch {
      return ''
    }
  }

  private findRawMessageByTs(
    ts: string,
    preferredChannel?: string
  ): SlackMessage | undefined {
    try {
      const state = this.api.redux.getRawState()
      const messages = state?.messages
      if (messages && typeof messages === 'object') {
        if (preferredChannel && messages[preferredChannel]?.[ts]) {
          return messages[preferredChannel][ts]
        }
        for (const ch of Object.keys(messages)) {
          if (messages[ch]?.[ts]) {
            return messages[ch][ts]
          }
        }
      }

      const threads = state?.threads
      if (threads && typeof threads === 'object') {
        for (const ch of Object.keys(threads)) {
          const chThreads = threads[ch]
          if (!chThreads || typeof chThreads !== 'object') continue
          for (const tTs of Object.keys(chThreads)) {
            const thread = chThreads[tTs]
            if (!thread || typeof thread !== 'object') continue
            if (thread[ts]) return thread[ts]
            if (Array.isArray(thread.replies)) {
              const r = thread.replies.find((m: any) => m?.ts === ts)
              if (r) return r
            }
            if (thread.messages && typeof thread.messages === 'object') {
              if (thread.messages[ts]) return thread.messages[ts]
            }
          }
        }
      }
    } catch {}
    return undefined
  }

  private getMessageFromFiber(
    el: Element | null
  ): { channel: string; ts: string } | null {
    if (!el) return null
    const key = Object.keys(el).find(
      (k) =>
        k.startsWith('__reactFiber$') ||
        k.startsWith('__reactInternalInstance$') ||
        k === '_reactInternals'
    )
    const f = key
      ? (el as any)[key]
      : (globalThis as any).getFiberFromNode?.(el)
    for (
      let curr = f, hops = 0;
      curr && hops < 50;
      curr = curr.return, hops++
    ) {
      const props = curr.memoizedProps || curr.pendingProps
      if (!props || typeof props !== 'object') continue

      const msg = props.message || props.msg || props.event || props.item
      if (msg && typeof msg === 'object' && msg.ts) {
        return {
          channel:
            msg.channel ||
            props.channel ||
            props.channelId ||
            this.currentChannelId,
          ts: String(msg.ts),
        }
      }
      if (
        props.ts &&
        typeof props.ts === 'string' &&
        /^\d{10}\.\d{6}/.test(props.ts)
      ) {
        return {
          channel: props.channel || props.channelId || this.currentChannelId,
          ts: props.ts,
        }
      }
      if (
        props.messageTs &&
        typeof props.messageTs === 'string' &&
        /^\d{10}\.\d{6}/.test(props.messageTs)
      ) {
        return {
          channel: props.channel || props.channelId || this.currentChannelId,
          ts: props.messageTs,
        }
      }
    }
    return null
  }

  private findMessageFromElement(
    el: Element | null
  ): { channel: string; ts: string } | null {
    if (!el) return null

    const tagged = el.closest('[data-taut-ml-ts]')
    if (tagged) {
      const ts = tagged.getAttribute('data-taut-ml-ts')
      const channel =
        tagged.getAttribute('data-taut-ml-channel') || this.currentChannelId
      if (ts) return { channel, ts }
    }

    const row = el.closest(
      '.c-message, .c-message_kit__message, .c-message_actions__container, .c-virtual_list__item, [data-qa="message_container"], [data-qa="message_content"], [id^="message-list_"][role="listitem"]'
    )
    if (row) {
      const childTagged = row.querySelector('[data-taut-ml-ts]')
      if (childTagged) {
        const ts = childTagged.getAttribute('data-taut-ml-ts')
        const channel =
          childTagged.getAttribute('data-taut-ml-channel') ||
          this.currentChannelId
        if (ts) return { channel, ts }
      }

      const attr =
        row.getAttribute('data-ts') ||
        row.getAttribute('data-message-ts') ||
        row.id ||
        ''
      const match = String(attr).match(/\d{10}\.\d{6}/)
      if (match) {
        return { channel: this.currentChannelId, ts: match[0] }
      }

      const fromFiber = this.getMessageFromFiber(row)
      if (fromFiber) return fromFiber
    }

    const attr =
      el.getAttribute('data-ts') ||
      el.getAttribute('data-message-ts') ||
      el.id ||
      ''
    const match = String(attr).match(/\d{10}\.\d{6}/)
    if (match) {
      return { channel: this.currentChannelId, ts: match[0] }
    }

    return this.getMessageFromFiber(el)
  }

  private extractTextFromBlocks(blocks: unknown): string {
    if (!Array.isArray(blocks)) return ''
    const pieces: string[] = []
    const walk = (node: any) => {
      if (!node) return
      if (typeof node === 'string') {
        pieces.push(node)
        return
      }
      if (typeof node.text === 'string') {
        pieces.push(node.text)
      } else if (node.text && typeof node.text === 'object') {
        walk(node.text)
      }
      if (node.type === 'user' && typeof node.user_id === 'string') {
        pieces.push(`<@${node.user_id}>`)
      }
      if (node.type === 'channel' && typeof node.channel_id === 'string') {
        pieces.push(`<#${node.channel_id}>`)
      }
      if (node.type === 'emoji' && typeof node.name === 'string') {
        pieces.push(`:${node.name}:`)
      }
      if (node.type === 'link' && typeof node.url === 'string') {
        pieces.push(node.text ? `<${node.url}|${node.text}>` : node.url)
      }
      if (Array.isArray(node.elements)) {
        for (const child of node.elements) walk(child)
      }
      if (Array.isArray(node.blocks)) {
        for (const child of node.blocks) walk(child)
      }
    }
    for (const b of blocks) walk(b)
    return pieces.join(' ').trim()
  }

  private extractMessageText(msg?: SlackMessage | KnownMessage): string {
    if (!msg) return ''
    if (typeof msg.text === 'string' && msg.text.trim()) {
      return msg.text
    }
    if (msg.blocks) {
      const text = this.extractTextFromBlocks(msg.blocks)
      if (text) return text
    }
    return ''
  }

  private rememberMessage(
    channel: string,
    ts: string,
    msg: SlackMessage
  ): void {
    if (!ts) return
    const key = this.keyOf(channel, ts)
    const existing = this.known.get(key)
    const text = typeof msg.text === 'string' ? msg.text : existing?.text

    if (
      existing &&
      existing.text === text &&
      existing.blocks === msg.blocks &&
      existing.user === msg.user &&
      existing.thread_ts === msg.thread_ts
    ) {
      return
    }

    const entry: KnownMessage = {
      channel,
      ts,
      user: (msg.user as string) || existing?.user,
      text,
      blocks: (msg.blocks as unknown[]) || existing?.blocks,
      attachments:
        (msg.attachments as SlackAttachment[]) || existing?.attachments,
      files: (msg.files as unknown[]) || existing?.files,
      bot_id: (msg.bot_id as string) || existing?.bot_id,
      app_id: (msg.app_id as string) || existing?.app_id,
      metadata: (msg.metadata as Record<string, unknown>) || existing?.metadata,
      thread_ts: (msg.thread_ts as string) || existing?.thread_ts,
      reply_count:
        typeof msg.reply_count === 'number'
          ? msg.reply_count
          : existing?.reply_count,
      reply_users: (msg.reply_users as string[]) || existing?.reply_users,
      latest_reply: (msg.latest_reply as string) || existing?.latest_reply,
    }
    this.known.set(key, entry)
    if (channel) this.known.set(this.keyOf('', ts), entry)

    if (this.isSelfUser(entry.user)) {
      this.markSelfMessage(ts)
    }

    if (this.known.size > MAX_KNOWN_MESSAGES) {
      const iter = this.known.keys()
      for (let i = 0; i < 50; i++) {
        const nextKey = iter.next().value
        if (!nextKey) break
        this.known.delete(nextKey)
      }
    }
  }

  private parseChannelAndTs(
    urlStr: string,
    body?: BodyInit | XMLHttpRequestBodyInit | null
  ): { channel: string; ts: string } {
    let channel = ''
    let ts = ''

    try {
      const parsedUrl = new URL(urlStr, window.location.origin)
      channel =
        parsedUrl.searchParams.get('channel') ||
        parsedUrl.searchParams.get('channel_id') ||
        ''
      ts =
        parsedUrl.searchParams.get('ts') ||
        parsedUrl.searchParams.get('message_ts') ||
        parsedUrl.searchParams.get('deleted_ts') ||
        ''
    } catch {}

    if ((!channel || !ts) && body) {
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        channel =
          channel ||
          (body.get('channel') as string) ||
          (body.get('channel_id') as string) ||
          ''
        ts =
          ts ||
          (body.get('ts') as string) ||
          (body.get('message_ts') as string) ||
          (body.get('deleted_ts') as string) ||
          ''
      } else if (
        typeof URLSearchParams !== 'undefined' &&
        body instanceof URLSearchParams
      ) {
        channel = channel || body.get('channel') || body.get('channel_id') || ''
        ts =
          ts ||
          body.get('ts') ||
          body.get('message_ts') ||
          body.get('deleted_ts') ||
          ''
      } else if (typeof body === 'string') {
        try {
          const parsed = JSON.parse(body)
          channel = channel || parsed.channel || parsed.channel_id || ''
          ts = ts || parsed.ts || parsed.message_ts || parsed.deleted_ts || ''
        } catch {
          const params = new URLSearchParams(body)
          channel =
            channel || params.get('channel') || params.get('channel_id') || ''
          ts =
            ts ||
            params.get('ts') ||
            params.get('message_ts') ||
            params.get('deleted_ts') ||
            ''
        }
      }
    }

    return { channel, ts }
  }

  private shouldIgnoreDeletion(msg?: KnownMessage | SlackMessage): boolean {
    if (!msg) return false
    const options = this.options
    if (
      options.ignoreSelf !== false &&
      this.isSelfUser(msg.user as string | undefined)
    ) {
      return true
    }

    const botId =
      (msg.bot_id as string | undefined) ||
      (msg.taut_bot_id as string | undefined) ||
      (msg.app_id as string | undefined) ||
      ((msg as SlackMessage).bot_profile as { id?: string } | undefined)?.id
    const isBot = Boolean(botId || msg.subtype === 'bot_message')

    switch (options.ignoreAnchors) {
      case 'lax':
        return isBot
      case 'strict':
        return (
          isBot &&
          (msg.metadata as { event_type?: string } | undefined)?.event_type ===
            'anchor'
        )
      default:
        return false
    }
  }

  private maybeNotify(
    type: 'delete' | 'edit',
    channelId: string,
    userId?: string,
    text?: string
  ): void {
    if (type === 'delete' && !this.options.notifyOnDelete) return
    if (type === 'edit' && !this.options.notifyOnEdit) return
    if (this.options.ignoreSelf !== false && this.isSelfUser(userId)) return

    const now = Date.now()
    if (now - this.lastNotificationTime < 1500) return
    this.lastNotificationTime = now

    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'default') {
      void Notification.requestPermission()
      return
    }
    if (Notification.permission !== 'granted') return

    const channelObj = this.api.channels.getCachedChannel(channelId)
    const channelName = channelObj?.name ? `#${channelObj.name}` : 'channel'
    const member = userId ? this.api.members.getCachedMember(userId) : undefined
    const userName =
      member?.profile?.display_name ||
      member?.real_name ||
      member?.name ||
      'Someone'

    const title =
      type === 'delete'
        ? `Message deleted in ${channelName}`
        : `Message edited in ${channelName}`

    const cleanSnippet = (text || '').replace(/\s+/g, ' ').trim().slice(0, 140)
    const body = cleanSnippet ? `${userName}: ${cleanSnippet}` : userName

    try {
      new Notification(title, {
        body,
        silent: false,
      })
    } catch {}
  }

  private handleEdit(event: RtmEvent): void {
    const previous = (event.previous_message || {}) as SlackMessage
    const message = (event.message || {}) as SlackMessage
    const ts = (message.ts || previous.ts || event.ts) as string | undefined
    if (!ts) return
    const channel = (event.channel ||
      message.channel ||
      previous.channel ||
      this.currentChannelId) as string
    const user = (message.user ||
      previous.user ||
      (message.edited as { user?: string })?.user) as string | undefined

    if (this.isSelfDeleted(ts)) return

    const isSelf =
      this.isSelfMessage(ts) ||
      this.isSelfUser(user) ||
      this.isSelfUser(message.user as string | undefined) ||
      this.isSelfUser(previous.user as string | undefined)

    if (isSelf) {
      this.markSelfMessage(ts)
    }

    const key = this.keyOf(channel, ts)
    const raw = this.api.messages.getRawMessage(channel, ts)
    const known = this.known.get(key) || this.known.get(this.keyOf('', ts))
    const oldText =
      this.extractMessageText(previous) ||
      (raw ? this.extractMessageText(raw) : '') ||
      (known ? this.extractMessageText(known) : '')
    const newText = this.extractMessageText(message)

    if (!oldText || !newText || oldText === newText) return

    let list = this.edits.get(key)
    if (!list) {
      list = []
      this.edits.set(key, list)
      if (channel) this.edits.set(this.keyOf('', ts), list)
    }

    const last = list[list.length - 1]
    if (last && last.oldText === oldText && last.newText === newText) return

    list.push({
      oldText,
      newText,
      editedAt: Date.now(),
    })

    if (list.length > 20) list.shift()
    if (this.edits.size > MAX_EDIT_LOGS) {
      const iter = this.edits.keys()
      for (let i = 0; i < 20; i++) {
        const nextKey = iter.next().value
        if (!nextKey) break
        this.edits.delete(nextKey)
      }
    }

    this.rememberMessage(channel, ts, message)
    this.maybeNotify('edit', channel, user, newText)
    this.scheduleSave()
    this.api.redux.refresh()
  }

  private handleDelete(event: RtmEvent): void {
    const previous = (event.previous_message || {}) as SlackMessage
    const message = (event.message || {}) as SlackMessage
    const ts = (event.deleted_ts ||
      (message as any)?.deleted_ts ||
      message.ts ||
      previous.ts ||
      event.ts) as string | undefined
    if (!ts) return

    const channel = (event.channel ||
      (previous as SlackMessage)?.channel ||
      (message as SlackMessage)?.channel ||
      this.currentChannelId) as string
    const key = this.keyOf(channel, ts)

    const raw =
      this.findRawMessageByTs(ts, channel) ||
      this.api.messages.getRawMessage(channel, ts)
    const existingDeleted =
      this.deleted.get(key) || this.deleted.get(this.keyOf('', ts))
    const known = this.known.get(key) || this.known.get(this.keyOf('', ts))
    const candidate =
      raw ||
      existingDeleted ||
      known ||
      (event.previous_message ? previous : undefined) ||
      (event.message ? message : undefined)

    const user =
      (candidate?.user as string | undefined) ||
      (existingDeleted?.user as string | undefined) ||
      (previous.user as string | undefined) ||
      (known?.user as string | undefined) ||
      (raw?.user as string | undefined) ||
      (event.user as string | undefined) ||
      (event.previous_user as string | undefined) ||
      (message.user as string | undefined)

    const isSelfDelete =
      this.isSelfDeleted(ts) ||
      this.isSelfMessage(ts) ||
      this.isSelfUser(user) ||
      this.isSelfUser(candidate?.user as string | undefined) ||
      this.isSelfUser(previous.user as string | undefined) ||
      this.isSelfUser(message.user as string | undefined)

    if (this.options.ignoreSelf !== false && isSelfDelete) {
      this.markSelfDeleted(ts)
      this.markSelfMessage(ts)
      this.purgeSelfMessage(channel, ts)
      this.scheduleSave()
      this.api.redux.refresh()
      return
    }

    if (this.shouldIgnoreDeletion(candidate)) {
      this.deleted.delete(key)
      this.deleted.delete(this.keyOf('', ts))
      this.scheduleSave()
      this.api.redux.refresh()
      return
    }

    const editList = this.getEdits(channel, ts)
    const latestEditText =
      editList[editList.length - 1]?.newText ||
      editList[editList.length - 1]?.oldText

    const text =
      this.extractMessageText(raw) ||
      this.extractMessageText(known) ||
      this.extractMessageText(existingDeleted) ||
      this.extractMessageText(previous) ||
      this.extractMessageText(message) ||
      latestEditText

    const thread_ts =
      (candidate as SlackMessage)?.thread_ts ||
      (event.thread_ts as string | undefined) ||
      (message.thread_ts as string | undefined) ||
      (previous.thread_ts as string | undefined)

    const hasFiles =
      Array.isArray((candidate as any)?.files) &&
      (candidate as any).files.length > 0
    const hasAttachments =
      Array.isArray((candidate as any)?.attachments) &&
      (candidate as any).attachments.length > 0
    const fallbackText = hasFiles
      ? `(shared ${(candidate as any).files.length} file${(candidate as any).files.length > 1 ? 's' : ''})`
      : hasAttachments
        ? '(attachment)'
        : '(empty message)'

    const isBroadcast =
      candidate?.subtype === 'thread_broadcast' ||
      (event as any)?.subtype === 'thread_broadcast' ||
      (message as any)?.subtype === 'thread_broadcast'

    const deletedRecord: DeletedRecord = {
      ...((candidate as SlackMessage) || {}),
      channel,
      ts,
      user,
      thread_ts,
      text: text || fallbackText,
      taut_deleted: true,
      taut_deleted_at: Date.now(),
    }
    if (isBroadcast) {
      deletedRecord.subtype = 'thread_broadcast'
    } else {
      delete deletedRecord.subtype
    }
    delete (deletedRecord as any).deleted
    delete (deletedRecord as any).hidden
    delete (deletedRecord as any).is_delayed_message

    this.deleted.set(key, deletedRecord)
    if (channel) this.deleted.set(this.keyOf('', ts), deletedRecord)

    if (this.deleted.size > MAX_DELETED_MESSAGES) {
      const iter = this.deleted.keys()
      for (let i = 0; i < 20; i++) {
        const nextKey = iter.next().value
        if (!nextKey) break
        this.deleted.delete(nextKey)
      }
    }

    this.maybeNotify('delete', channel, user, text || fallbackText)
    this.scheduleSave()
    this.api.redux.refresh()
  }

  private handleClientDelete(channel: string, ts: string): void {
    if (!ts) return
    const raw =
      this.api.messages.getRawMessage(channel, ts) ||
      this.findRawMessageByTs(ts, channel)
    if (!raw) return

    const resolvedChannel =
      channel || (raw.channel as string) || this.currentChannelId
    this.rememberMessage(resolvedChannel, ts, raw)
    this.handleDelete({
      channel: resolvedChannel,
      ts,
      deleted_ts: ts,
      previous_message: raw,
    })
  }

  private handleRtmMessage(event: RtmEvent): void {
    if (!event) return
    const subtype = event.subtype
    const msgObj = event.message as
      | { subtype?: string; deleted?: boolean }
      | undefined
    const isTombstone =
      (subtype === 'message_changed' &&
        (msgObj?.subtype === 'tombstone' || msgObj?.deleted === true)) ||
      subtype === 'message_deleted' ||
      event.deleted === true

    if (isTombstone) {
      this.handleDelete(event)
      return
    }

    if (subtype === 'message_changed') {
      this.handleEdit(event)
      return
    }

    if (!subtype && event.ts) {
      const channel = (event.channel || this.currentChannelId) as string
      this.rememberMessage(channel, event.ts as string, event as SlackMessage)
    }
  }

  private purgeExpiredLogs(): void {
    const days = this.options.retentionDays
    if (typeof days !== 'number' || days <= 0) return

    const cutoff = Date.now() - days * 86400 * 1000
    let purged = 0

    for (const [key, record] of this.deleted.entries()) {
      if (record.taut_deleted_at && record.taut_deleted_at < cutoff) {
        this.deleted.delete(key)
        this.vanishedMessages.delete(key)
        this.cleanMessages.delete(key)
        purged++
      }
    }

    for (const [key, editList] of this.edits.entries()) {
      const latest = editList[editList.length - 1]?.editedAt || 0
      if (latest && latest < cutoff) {
        this.edits.delete(key)
        this.hiddenEdits.delete(key)
        purged++
      }
    }

    for (const key of this.vanishedMessages) {
      if (!this.deleted.has(key)) this.vanishedMessages.delete(key)
    }
    for (const key of this.cleanMessages) {
      if (!this.deleted.has(key)) this.cleanMessages.delete(key)
    }
    for (const key of this.hiddenEdits) {
      if (!this.edits.has(key)) this.hiddenEdits.delete(key)
    }

    if (purged > 0) {
      this.scheduleSave()
      this.api.redux.refresh()
    }
  }

  private isMessageDeleted(channel: string | undefined, ts: string): boolean {
    if (
      this.deleted.has(this.keyOf(channel, ts)) ||
      this.deleted.has(this.keyOf('', ts))
    ) {
      return true
    }
    const raw = this.findRawMessageByTs(ts, channel)
    return Boolean((raw as any)?.taut_deleted)
  }

  private isMessageEdited(channel: string | undefined, ts: string): boolean {
    const list =
      this.edits.get(this.keyOf(channel, ts)) ||
      this.edits.get(this.keyOf('', ts))
    return Boolean(list && list.length > 0)
  }

  private getEdits(channel: string | undefined, ts: string): EditEntry[] {
    return (
      this.edits.get(this.keyOf(channel, ts)) ||
      this.edits.get(this.keyOf('', ts)) ||
      []
    )
  }

  private isMessageVanished(channel: string | undefined, ts: string): boolean {
    return (
      this.vanishedMessages.has(this.keyOf(channel, ts)) ||
      this.vanishedMessages.has(this.keyOf('', ts))
    )
  }

  private isCleanView(channel: string | undefined, ts: string): boolean {
    if (!this.isMessageDeleted(channel, ts)) return false
    return (
      this.cleanMessages.has(this.keyOf(channel, ts)) ||
      this.cleanMessages.has(this.keyOf('', ts))
    )
  }

  private isEditsHidden(channel: string | undefined, ts: string): boolean {
    return (
      this.hiddenEdits.has(this.keyOf(channel, ts)) ||
      this.hiddenEdits.has(this.keyOf('', ts))
    )
  }

  private toggleCleanView(channel: string | undefined, ts: string): void {
    if (!this.isMessageDeleted(channel, ts)) return
    const key = this.keyOf(channel, ts)
    const altKey = this.keyOf('', ts)
    if (this.cleanMessages.has(key) || this.cleanMessages.has(altKey)) {
      this.cleanMessages.delete(key)
      this.cleanMessages.delete(altKey)
    } else {
      this.cleanMessages.add(key)
      if (channel) this.cleanMessages.add(altKey)
    }
    this.scheduleSave()
    this.api.redux.refresh()
  }

  private vanishMessage(channel: string | undefined, ts: string): void {
    const key = this.keyOf(channel, ts)
    const altKey = this.keyOf('', ts)
    this.vanishedMessages.add(key)
    if (channel) this.vanishedMessages.add(altKey)

    if (typeof document !== 'undefined') {
      const selectors = [
        `[data-taut-ml-ts="${ts}"]`,
        `[data-ts="${ts}"]`,
        `[data-message-ts="${ts}"]`,
        `#message-${ts.replace('.', '-')}`,
      ]
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const row =
            el.closest(
              '.c-virtual_list__item, .c-message_kit__message, [data-qa="message_container"], .c-message'
            ) || el
          ;(row as HTMLElement).classList.add('taut-ml-vanished')
          ;(row as HTMLElement).style.setProperty(
            'display',
            'none',
            'important'
          )
        })
      }
    }

    this.scheduleSave()
    this.api.redux.refresh()
  }

  private toggleVanishMessage(channel: string | undefined, ts: string): void {
    const key = this.keyOf(channel, ts)
    const altKey = this.keyOf('', ts)
    if (this.vanishedMessages.has(key) || this.vanishedMessages.has(altKey)) {
      this.vanishedMessages.delete(key)
      this.vanishedMessages.delete(altKey)
      this.scheduleSave()
      this.api.redux.refresh()
    } else {
      this.vanishMessage(channel, ts)
    }
  }

  private toggleHideEdits(channel: string | undefined, ts: string): void {
    const key = this.keyOf(channel, ts)
    const altKey = this.keyOf('', ts)
    if (this.hiddenEdits.has(key) || this.hiddenEdits.has(altKey)) {
      this.hiddenEdits.delete(key)
      this.hiddenEdits.delete(altKey)
    } else {
      this.hiddenEdits.add(key)
      if (channel) this.hiddenEdits.add(altKey)
    }
    this.scheduleSave()
    this.api.redux.refresh()
  }

  private toggleGlobalHide(): void {
    this.isTemporarilyHidden = !this.isTemporarilyHidden
    if (this.isTemporarilyHidden) {
      document.body.classList.add('taut-ml-temporarily-hidden')
    } else {
      document.body.classList.remove('taut-ml-temporarily-hidden')
    }
    this.api.redux.refresh()
  }

  private formatRelativeTime(at: number): string {
    const timestamp = at < 1e11 ? at * 1000 : at
    const elapsed = Date.now() - timestamp
    if (elapsed < 45 * 1000) return 'just now'
    const minutes = Math.floor(elapsed / 60000)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}d ago`
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
    }).format(new Date(timestamp))
  }

  private formatAbsoluteTime(timestamp: number): string {
    if (!timestamp) return ''
    const ts = timestamp < 1e11 ? timestamp * 1000 : timestamp
    try {
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      }).format(new Date(ts))
    } catch {
      return ''
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer || this.api.signal.aborted) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.persistState()
    }, 1000)
  }

  private async persistState(): Promise<void> {
    if (this.api.signal.aborted) return
    try {
      await this.api.storage.set(
        'vanished_messages',
        Array.from(this.vanishedMessages)
      )
      await this.api.storage.set(
        'clean_messages',
        Array.from(this.cleanMessages)
      )
      await this.api.storage.set('hidden_edits', Array.from(this.hiddenEdits))

      if (this.options.persistLogs !== false) {
        const deletedArr = Array.from(this.deleted.entries())
          .filter(([k]) => !k.startsWith('*:'))
          .slice(-300)
        await this.api.storage.set('deleted_logs', deletedArr)

        const editsArr = Array.from(this.edits.entries())
          .filter(([k]) => !k.startsWith('*:'))
          .slice(-300)
        await this.api.storage.set('edit_logs', editsArr)
      }
    } catch (err) {
      this.log('failed to persist state', err)
    }
  }

  private async loadPersistedState(): Promise<void> {
    try {
      const vanished = await this.api.storage.get<string[]>(
        'vanished_messages',
        []
      )
      for (const k of vanished) this.vanishedMessages.add(k)

      const clean = await this.api.storage.get<string[]>('clean_messages', [])
      for (const k of clean) this.cleanMessages.add(k)

      const hiddenEd = await this.api.storage.get<string[]>('hidden_edits', [])
      for (const k of hiddenEd) this.hiddenEdits.add(k)

      if (this.options.persistLogs !== false) {
        const deletedArr = await this.api.storage.get<
          Array<[string, DeletedRecord]>
        >('deleted_logs', [])
        for (const [k, v] of deletedArr) {
          if (v?.ts) {
            if (
              this.options.ignoreSelf !== false &&
              this.isSelfUser(v.user as string | undefined)
            ) {
              continue
            }
            this.deleted.set(k, v)
            if (v.channel) this.deleted.set(this.keyOf('', v.ts), v)
          }
        }

        const editsArr = await this.api.storage.get<
          Array<[string, EditEntry[]]>
        >('edit_logs', [])
        for (const [k, v] of editsArr) {
          if (Array.isArray(v) && v.length) {
            this.edits.set(k, v)
            const split = k.indexOf(':')
            if (split !== -1) {
              this.edits.set(this.keyOf('', k.slice(split + 1)), v)
            }
          }
        }
      }

      if (this.options.ignoreSelf !== false) {
        let purgedSelf = false
        for (const rec of Array.from(this.deleted.values())) {
          if (!rec.ts) continue
          const rawUser =
            rec.user || this.findRawMessageByTs(rec.ts, rec.channel)?.user
          if (
            this.isSelfDeleted(rec.ts) ||
            this.isSelfMessage(rec.ts) ||
            this.isSelfUser(rawUser as string | undefined)
          ) {
            this.purgeSelfMessage(rec.channel, rec.ts)
            purgedSelf = true
          }
        }
        for (const [key] of Array.from(this.edits.entries())) {
          const split = key.indexOf(':')
          const ts = split !== -1 ? key.slice(split + 1) : key
          if (this.isSelfDeleted(ts)) {
            this.purgeSelfMessage(undefined, ts)
            purgedSelf = true
          }
        }
        if (purgedSelf) {
          void this.persistState()
        }
      }
    } catch (err) {
      this.log('failed to load persisted state', err)
    }
  }

  private setupFetchInterceptor(): () => void {
    const originalFetch = window.fetch
    const self = this

    ;(window as any).fetch = async function (
      input: RequestInfo | URL,
      init?: RequestInit
    ) {
      try {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request)?.url || ''

        if (url.includes('chat.delete')) {
          let { channel, ts } = self.parseChannelAndTs(url, init?.body)
          if (
            !ts &&
            typeof Request !== 'undefined' &&
            input instanceof Request
          ) {
            const parsed = self.parseChannelAndTs(input.url, undefined)
            channel = channel || parsed.channel
            ts = ts || parsed.ts
            if (!ts) {
              try {
                input
                  .clone()
                  .text()
                  .then((bodyText) => {
                    const asyncParsed = self.parseChannelAndTs(
                      input.url,
                      bodyText
                    )
                    if (asyncParsed.ts) {
                      self.markSelfDeleted(asyncParsed.ts)
                      self.markSelfMessage(asyncParsed.ts)
                      const rawMsg = self.findRawMessageByTs(
                        asyncParsed.ts,
                        asyncParsed.channel
                      )
                      if (rawMsg?.user) {
                        self.selfUserIdsCache.add(rawMsg.user)
                      }
                      self.purgeSelfMessage(asyncParsed.channel, asyncParsed.ts)
                      self.scheduleSave()
                      self.api.redux.refresh()
                    }
                  })
                  .catch(() => {})
              } catch {}
            }
          }
          if (ts) {
            self.markSelfDeleted(ts)
            self.markSelfMessage(ts)
            const rawMsg = self.findRawMessageByTs(ts, channel)
            if (rawMsg?.user) {
              self.selfUserIdsCache.add(rawMsg.user)
            }
            self.purgeSelfMessage(channel, ts)
          }
          if (self.options.ignoreSelf !== false) {
            return originalFetch.call(this, input, init)
          }
          self.handleClientDelete(channel, ts)
        } else if (url.includes('chat.update')) {
          const { ts } = self.parseChannelAndTs(url, init?.body)
          if (ts) {
            self.markSelfMessage(ts)
          }
        }
      } catch (err) {
        self.log('fetch intercept error', err)
      }

      return originalFetch.call(this, input, init)
    }

    return () => {
      ;(window as any).fetch = originalFetch
    }
  }

  private setupXhrInterceptor(): () => void {
    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    const self = this

    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      ...rest: any[]
    ) {
      ;(this as any).__tautUrl = String(url)
      return (originalOpen as any).apply(this, [method, url, ...rest])
    }

    XMLHttpRequest.prototype.send = function (body?: any) {
      try {
        const url = (this as any).__tautUrl || ''
        if (url.includes('chat.delete')) {
          const { channel, ts } = self.parseChannelAndTs(url, body)
          if (ts) {
            self.markSelfDeleted(ts)
            self.markSelfMessage(ts)
            const rawMsg = self.findRawMessageByTs(ts, channel)
            if (rawMsg?.user) {
              self.selfUserIdsCache.add(rawMsg.user)
            }
            self.purgeSelfMessage(channel, ts)
          }
          if (self.options.ignoreSelf !== false) {
            return originalSend.call(this, body)
          }
          self.handleClientDelete(channel, ts)
        } else if (url.includes('chat.update')) {
          const { ts } = self.parseChannelAndTs(url, body)
          if (ts) {
            self.markSelfMessage(ts)
          }
        }
      } catch (err) {
        self.log('xhr intercept error', err)
      }

      return originalSend.call(this, body)
    }

    return () => {
      XMLHttpRequest.prototype.open = originalOpen
      XMLHttpRequest.prototype.send = originalSend
    }
  }

  private setupKeyboardShortcut(): () => void {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }
      const isCmdOrCtrl = e.metaKey || e.ctrlKey
      if (isCmdOrCtrl && e.shiftKey && !e.altKey && e.code === 'KeyH') {
        e.preventDefault()
        this.toggleGlobalHide()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }

  private setupMenuTracking(): () => void {
    const onAction = (e: Event) => {
      const target = e.target as Element | null
      if (!target) return
      if (!target.closest('.c-menu, [role="menu"]')) {
        const found = this.findMessageFromElement(target)
        if (found) {
          this.activeMenuMessage = found
        }
      }
      this.checkMenus()
      requestAnimationFrame(() => this.checkMenus())
      setTimeout(() => this.checkMenus(), 25)
      setTimeout(() => this.checkMenus(), 75)
      setTimeout(() => this.checkMenus(), 150)
    }

    window.addEventListener('contextmenu', onAction, { capture: true })
    window.addEventListener('pointerdown', onAction, { capture: true })

    return () => {
      window.removeEventListener('contextmenu', onAction, { capture: true })
      window.removeEventListener('pointerdown', onAction, { capture: true })
    }
  }

  private checkMenus(): void {
    if (this.isTemporarilyHidden || typeof document === 'undefined') return
    const menus = Array.from(
      document.querySelectorAll<HTMLElement>('.c-menu, [role="menu"]')
    )
    for (const menu of menus) {
      this.injectMenuItemsIntoMenu(menu)
    }
  }

  private injectMenuItemsIntoMenu(menu: HTMLElement): void {
    if (this.isTemporarilyHidden) return

    const msgInfo =
      this.activeMenuMessage ||
      this.getMessageFromFiber(menu) ||
      this.findMessageFromElement(document.activeElement)

    if (!msgInfo?.ts) return
    const channel = msgInfo.channel || this.currentChannelId
    const ts = msgInfo.ts

    const isDeleted = this.isMessageDeleted(channel, ts)
    const isEdited = this.isMessageEdited(channel, ts)
    if (!isDeleted && !isEdited) return

    const menuKey = `${channel}:${ts}`
    const existing = menu.querySelector('[data-taut-ml-menu]')
    if (
      existing &&
      existing.getAttribute('data-taut-ml-menu-key') === menuKey
    ) {
      return
    }

    if (existing) {
      menu.querySelectorAll('[data-taut-ml-menu]').forEach((el) => {
        const row = el.closest('li, .c-menu_item__li') || el
        row.remove()
      })
    }

    const items = menu.querySelectorAll<HTMLElement>(
      'button, [role="menuitem"]'
    )
    if (!items.length) return
    const reference = items[items.length - 1]
    const referenceRow = reference.closest('li, .c-menu_item__li') || reference

    const isClean = this.isCleanView(channel, ts)
    const isEdHidden = this.isEditsHidden(channel, ts)

    const createMenuItem = (
      actionKey: string,
      label: string,
      isDanger: boolean,
      onClick: () => void
    ): HTMLElement => {
      const clone = referenceRow.cloneNode(true) as HTMLElement
      const btn = (
        clone.matches('button, [role="menuitem"]')
          ? clone
          : clone.querySelector('button, [role="menuitem"]')
      ) as HTMLElement | null

      if (!btn) return clone

      clone.setAttribute('data-taut-ml-menu', actionKey)
      clone.setAttribute('data-taut-ml-menu-key', menuKey)
      clone.removeAttribute('id')
      clone.querySelectorAll('[id]').forEach((el) => {
        el.removeAttribute('id')
      })

      for (const attr of [
        'data-qa',
        'aria-controls',
        'aria-describedby',
        'aria-expanded',
        'aria-haspopup',
      ]) {
        btn.removeAttribute(attr)
      }

      for (const el of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
        if (el.classList) {
          const toRemove: string[] = []
          for (const cls of Array.from(el.classList)) {
            if (/highlight|selected/i.test(cls)) toRemove.push(cls)
          }
          for (const cls of toRemove) el.classList.remove(cls)
        }
        if (el.getAttribute('aria-selected') === 'true') {
          el.setAttribute('aria-selected', 'false')
        }
        el.removeAttribute('aria-current')
      }

      if (isDanger) {
        btn.classList.add('c-menu_item__button--danger')
        btn.style.color = 'var(--dt_color-content-negative, #e01e5a)'
      } else {
        btn.classList.remove('c-menu_item__button--danger')
      }

      const labelEl = clone.querySelector('.c-menu_item__label')
      if (labelEl) {
        labelEl.textContent = label
      } else {
        btn.textContent = label
      }

      clone
        .querySelectorAll('svg, .c-icon, .c-menu_item__icon')
        .forEach((el) => {
          el.remove()
        })

      btn.addEventListener('mouseenter', () => {
        for (const other of Array.from(
          menu.querySelectorAll<HTMLElement>('button, [role="menuitem"]')
        )) {
          if (other !== btn) {
            const otherRow = other.closest('li, .c-menu_item__li') || other
            for (const el of [
              otherRow,
              ...Array.from(otherRow.querySelectorAll('*')),
            ]) {
              if (el.classList) {
                const toRemove: string[] = []
                for (const cls of Array.from(el.classList)) {
                  if (/highlight/i.test(cls)) toRemove.push(cls)
                }
                for (const cls of toRemove) el.classList.remove(cls)
              }
            }
          }
        }
        btn.classList.add('c-menu_item__button--highlighted')
        const rowWrapper = btn.closest('li, .c-menu_item__li')
        if (rowWrapper) rowWrapper.classList.add('c-menu_item__li--highlighted')
      })

      btn.addEventListener('mouseleave', () => {
        btn.classList.remove('c-menu_item__button--highlighted')
        const rowWrapper = btn.closest('li, .c-menu_item__li')
        if (rowWrapper)
          rowWrapper.classList.remove('c-menu_item__li--highlighted')
      })

      btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        )
        onClick()
      })

      return clone
    }

    const newRows: HTMLElement[] = []

    const existingSep = menu.querySelector(
      '.c-menu__separator, [role="separator"]'
    )
    const sep = existingSep
      ? (existingSep.cloneNode(true) as HTMLElement)
      : document.createElement('div')
    if (!existingSep) {
      sep.className = 'c-menu__separator'
      sep.setAttribute('role', 'separator')
    }
    sep.setAttribute('data-taut-ml-menu', 'separator')
    sep.setAttribute('data-taut-ml-menu-key', menuKey)
    newRows.push(sep)

    if (isDeleted) {
      newRows.push(
        createMenuItem('delete', 'Delete message', true, () => {
          this.vanishMessage(channel, ts)
        })
      )
      newRows.push(
        createMenuItem(
          'clean',
          isClean ? 'Show deletion notice' : 'Hide deletion notice',
          false,
          () => {
            this.toggleCleanView(channel, ts)
          }
        )
      )
    }

    if (isEdited) {
      newRows.push(
        createMenuItem(
          'edits',
          isEdHidden ? 'Show edit history' : 'Hide edit history',
          false,
          () => {
            this.toggleHideEdits(channel, ts)
          }
        )
      )
    }

    let insertAfter = referenceRow
    for (const row of newRows) {
      insertAfter.after(row)
      insertAfter = row
    }
  }

  private readonly TombstoneNotice = ({
    deletedAt,
    editCount = 0,
    onDismiss,
  }: {
    deletedAt?: number
    editCount?: number
    onDismiss?: () => void
  }) => {
    const relTime = deletedAt ? this.formatRelativeTime(deletedAt) : ''
    const fullTime = deletedAt ? this.formatAbsoluteTime(deletedAt) : ''

    const text =
      editCount > 0
        ? `This message was edited (${editCount} revision${editCount > 1 ? 's' : ''}), then deleted`
        : 'This message was deleted'

    return (
      <div
        className="taut-ml-tombstone-notice"
        data-stringify-ignore="true"
        title={fullTime ? `Deleted on ${fullTime}` : text}
      >
        <svg
          className="taut-ml-tombstone-icon"
          width="13"
          height="13"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
        <span className="taut-ml-tombstone-text">{text}</span>
        {relTime ? (
          <span className="taut-ml-tombstone-time">({relTime})</span>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            className="taut-ml-tombstone-hide-btn"
            onClick={onDismiss}
            title="Hide deletion notice"
          >
            [hide]
          </button>
        ) : null}
      </div>
    )
  }

  private readonly DiffView = ({
    oldText,
    newText,
  }: {
    oldText: string
    newText: string
  }) => {
    const diff = React.useMemo(
      () => computeWordDiff(oldText, newText),
      [oldText, newText]
    )

    return (
      <span className="taut-ml-diff-container">
        {diff.map((chunk, i) => {
          if (chunk.op === 'delete') {
            return (
              <del
                key={i}
                className="taut-ml-diff-del"
                title="Removed in revision"
              >
                {chunk.text}
              </del>
            )
          }
          if (chunk.op === 'insert') {
            return (
              <ins
                key={i}
                className="taut-ml-diff-ins"
                title="Added in revision"
              >
                {chunk.text}
              </ins>
            )
          }
          return <span key={i}>{chunk.text}</span>
        })}
      </span>
    )
  }

  private readonly DeletedFilesCard = ({ files }: { files?: unknown[] }) => {
    if (!Array.isArray(files) || !files.length) return null

    return (
      <div className="taut-ml-files-container" data-stringify-ignore="true">
        {files.map((rawFile: any, idx: number) => {
          const file = rawFile || {}
          const name = file.title || file.name || 'Attachment'
          const sizeStr = formatFileSize(file.size)
          const ext = (file.filetype || file.name?.split('.').pop() || 'FILE')
            .toUpperCase()
            .slice(0, 5)
          const thumb = file.thumb_80 || file.thumb_64 || file.thumb_360
          const url = file.url_private || file.permalink

          const content = (
            <>
              <div className="taut-ml-file-preview">
                {thumb ? (
                  <img
                    src={thumb}
                    alt={name}
                    className="taut-ml-file-thumb"
                    loading="lazy"
                  />
                ) : (
                  <div className="taut-ml-file-icon-box">
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        fillRule="evenodd"
                        d="M4 2a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V7.414A2 2 0 0017.414 6L13.414 2A2 2 0 0012 1.414H4zm7 2v3a1 1 0 001 1h3l-4-4zM4 4h6v4a2 2 0 002 2h4v6a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="taut-ml-file-ext">{ext}</span>
                  </div>
                )}
              </div>
              <div className="taut-ml-file-meta">
                <div className="taut-ml-file-name" title={name}>
                  {name}
                </div>
                <div className="taut-ml-file-sub">
                  <span className="taut-ml-file-badge">deleted file</span>
                  {sizeStr ? <span>• {sizeStr}</span> : null}
                  {file.pretty_type ? <span>• {file.pretty_type}</span> : null}
                </div>
              </div>
            </>
          )

          if (url) {
            return (
              <a
                key={file.id || idx}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="taut-ml-file-card taut-ml-file-card--link"
              >
                {content}
              </a>
            )
          }

          return (
            <div key={file.id || idx} className="taut-ml-file-card">
              {content}
            </div>
          )
        })}
      </div>
    )
  }

  private readonly EditHistorySection = ({ edits }: { edits: EditEntry[] }) => {
    if (!edits.length) return null

    const [isExpanded, setIsExpanded] = React.useState(
      !this.options.collapseEdits
    )

    const countText =
      edits.length > 1 ? `${edits.length} revisions` : '1 revision'

    return (
      <div className="taut-ml-edit-section" data-stringify-ignore="true">
        <button
          type="button"
          className="taut-ml-edit-toggle"
          onClick={() => setIsExpanded((prev) => !prev)}
        >
          <span className="c-message__edited_label">({countText})</span>
          <span className="taut-ml-edit-toggle-hint">
            {isExpanded ? 'hide history' : 'show history'}
          </span>
        </button>

        {isExpanded ? (
          <div className="taut-ml-edit-drawer">
            {edits.map((entry, idx) => (
              <div key={idx} className="taut-ml-edit-row">
                <span className="taut-ml-edit-vtag">v{idx + 1}</span>
                <this.DiffView
                  oldText={entry.oldText}
                  newText={entry.newText}
                />
                {entry.editedAt ? (
                  <span
                    className="taut-ml-edit-timestamp"
                    title={this.formatAbsoluteTime(entry.editedAt)}
                  >
                    • {this.formatRelativeTime(entry.editedAt)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  async start() {
    await this.loadPersistedState()
    if (this.api.signal.aborted) return

    this.fetchCleanup = this.setupFetchInterceptor()
    this.xhrCleanup = this.setupXhrInterceptor()
    this.keydownCleanup = this.setupKeyboardShortcut()
    this.menuTrackingCleanup = this.setupMenuTracking()

    this.purgeExpiredLogs()
    this.purgeTimer = setInterval(
      () => {
        this.purgeExpiredLogs()
      },
      4 * 3600 * 1000
    )

    this.api.setStyle(`
      .taut-ml-container {
        position: relative;
        margin-top: 1px;
      }

      .taut-ml-tombstone-notice {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 4px;
        font-size: 13px;
        line-height: 1.4;
        color: var(--dt_color-content-sec, #616061);
        user-select: none;
      }

      .sk-client-theme--dark .taut-ml-tombstone-notice {
        color: var(--dt_color-content-sec, #ababad);
      }

      .taut-ml-tombstone-icon {
        flex-shrink: 0;
        color: var(--dt_color-content-negative, #e01e5a);
      }

      .sk-client-theme--dark .taut-ml-tombstone-icon {
        color: #f24979;
      }

      .taut-ml-tombstone-text {
        font-style: italic;
      }

      .taut-ml-tombstone-time {
        font-style: normal;
        font-size: 11px;
        color: var(--dt_color-content-ter, #868686);
      }

      .taut-ml-tombstone-hide-btn {
        display: inline-flex;
        align-items: center;
        margin-left: 4px;
        padding: 0;
        border: none;
        background: transparent;
        cursor: pointer;
        font-size: 11px;
        color: var(--dt_color-content-ter, #868686);
        text-decoration: underline;
        text-underline-offset: 2px;
        opacity: 0.7;
      }

      .taut-ml-tombstone-hide-btn:hover {
        opacity: 1;
      }

      .taut-ml-deleted--red,
      .taut-ml-deleted--red .c-message__body,
      .taut-ml-deleted--red .p-rich_text_section,
      .taut-ml-deleted--red .p-rich_text_block,
      .taut-ml-deleted--red [data-qa="message-text"],
      .taut-ml-deleted--red .c-message_kit__text,
      .taut-ml-deleted--red a,
      .taut-ml-deleted--red code {
        color: var(--dt_color-content-negative, #e01e5a) !important;
      }

      .sk-client-theme--dark .taut-ml-deleted--red,
      .sk-client-theme--dark .taut-ml-deleted--red .c-message__body,
      .sk-client-theme--dark .taut-ml-deleted--red .p-rich_text_section,
      .sk-client-theme--dark .taut-ml-deleted--red .p-rich_text_block,
      .sk-client-theme--dark .taut-ml-deleted--red [data-qa="message-text"],
      .sk-client-theme--dark .taut-ml-deleted--red .c-message_kit__text,
      .sk-client-theme--dark .taut-ml-deleted--red a,
      .sk-client-theme--dark .taut-ml-deleted--red code {
        color: #f24979 !important;
      }

      .taut-ml-deleted--opacity {
        opacity: 0.55 !important;
      }

      .taut-ml-edit-section {
        margin-top: 2px;
        margin-bottom: 4px;
        user-select: none;
      }

      .taut-ml-edit-toggle {
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
        padding: 0;
        border: none;
        background: transparent;
        cursor: pointer;
        font: inherit;
        color: inherit;
      }

      .taut-ml-edit-toggle .c-message__edited_label {
        font-size: 12px;
        color: var(--dt_color-content-sec, #616061);
      }

      .sk-client-theme--dark .taut-ml-edit-toggle .c-message__edited_label {
        color: var(--dt_color-content-sec, #ababad);
      }

      .taut-ml-edit-toggle-hint {
        font-size: 11px;
        color: var(--dt_color-content-ter, #868686);
        text-decoration: underline;
        text-underline-offset: 2px;
        opacity: 0.8;
      }

      .taut-ml-edit-toggle:hover .taut-ml-edit-toggle-hint {
        opacity: 1;
        color: var(--dt_color-content-sec, #616061);
      }

      .taut-ml-edit-drawer {
        margin-top: 4px;
        margin-left: 2px;
        padding-left: 8px;
        border-left: 2px solid var(--dt_color-border-weak, rgba(0, 0, 0, 0.15));
        display: flex;
        flex-direction: column;
        gap: 3px;
        max-height: 260px;
        overflow-y: auto;
        user-select: text;
      }

      .sk-client-theme--dark .taut-ml-edit-drawer {
        border-left-color: var(--dt_color-border-weak, rgba(255, 255, 255, 0.18));
      }

      .taut-ml-edit-row {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 6px;
        font-size: 13px;
        line-height: 1.4;
        color: var(--dt_color-content-sec, #616061);
      }

      .sk-client-theme--dark .taut-ml-edit-row {
        color: var(--dt_color-content-sec, #ababad);
      }

      .taut-ml-edit-vtag {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        color: var(--dt_color-content-ter, #868686);
        flex-shrink: 0;
      }

      .taut-ml-diff-container {
        font-size: 13px;
        line-height: 1.4;
        word-break: break-word;
        white-space: pre-wrap;
      }

      .taut-ml-diff-del {
        background-color: var(--dt_color-surf-negative-sec, rgba(224, 30, 90, 0.14));
        color: var(--dt_color-content-negative, #e01e5a);
        text-decoration: line-through;
        padding: 0 3px;
        border-radius: 2px;
      }

      .sk-client-theme--dark .taut-ml-diff-del {
        background-color: rgba(242, 73, 121, 0.22);
        color: #f24979;
      }

      .taut-ml-diff-ins {
        background-color: var(--dt_color-surf-positive-sec, rgba(0, 122, 90, 0.14));
        color: var(--dt_color-content-positive, #007a5a);
        text-decoration: none;
        padding: 0 3px;
        border-radius: 2px;
      }

      .sk-client-theme--dark .taut-ml-diff-ins {
        background-color: rgba(46, 182, 125, 0.22);
        color: #2eb67d;
      }

      .taut-ml-edit-timestamp {
        font-size: 11px;
        color: var(--dt_color-content-ter, #868686);
        flex-shrink: 0;
      }

      .taut-ml-files-container {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 6px;
      }

      .taut-ml-file-card {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        border-radius: 6px;
        border: 1px solid var(--dt_color-border-weak, rgba(0, 0, 0, 0.14));
        background-color: var(--dt_color-surf-sec, rgba(0, 0, 0, 0.03));
        max-width: 440px;
        user-select: none;
      }

      .sk-client-theme--dark .taut-ml-file-card {
        border-color: var(--dt_color-border-weak, rgba(255, 255, 255, 0.14));
        background-color: var(--dt_color-surf-sec, rgba(255, 255, 255, 0.04));
      }

      .taut-ml-file-card--link {
        text-decoration: none;
        color: inherit;
        cursor: pointer;
      }

      .taut-ml-file-card--link:hover {
        background-color: var(--dt_color-surf-sec, rgba(0, 0, 0, 0.06));
      }

      .sk-client-theme--dark .taut-ml-file-card--link:hover {
        background-color: rgba(255, 255, 255, 0.08);
      }

      .taut-ml-file-preview {
        width: 36px;
        height: 36px;
        border-radius: 4px;
        overflow: hidden;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: var(--dt_color-surf-sec, rgba(0, 0, 0, 0.06));
      }

      .sk-client-theme--dark .taut-ml-file-preview {
        background-color: rgba(255, 255, 255, 0.1);
      }

      .taut-ml-file-thumb {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .taut-ml-file-icon-box {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: var(--dt_color-content-ter, #868686);
      }

      .taut-ml-file-ext {
        font-size: 8px;
        font-weight: 700;
        line-height: 1;
        margin-top: 1px;
      }

      .taut-ml-file-meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
        overflow: hidden;
      }

      .taut-ml-file-name {
        font-size: 13px;
        font-weight: 700;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--dt_color-content-pri, #1d1c1d);
      }

      .sk-client-theme--dark .taut-ml-file-name {
        color: #fff;
      }

      .taut-ml-file-sub {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: var(--dt_color-content-ter, #868686);
      }

      .taut-ml-file-badge {
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.3px;
        padding: 0 3px;
        border-radius: 2px;
        background-color: var(--dt_color-surf-negative-sec, rgba(224, 30, 90, 0.12));
        color: var(--dt_color-content-negative, #e01e5a);
      }

      .sk-client-theme--dark .taut-ml-file-badge {
        background-color: rgba(242, 73, 121, 0.2);
        color: #f24979;
      }

      body.taut-ml-temporarily-hidden .taut-ml-tombstone-notice,
      body.taut-ml-temporarily-hidden .taut-ml-edit-section,
      body.taut-ml-temporarily-hidden .taut-ml-file-badge,
      body.taut-ml-temporarily-hidden .taut-ml-files-container,
      body.taut-ml-temporarily-hidden .taut-ml-container.taut-ml-deleted,
      body.taut-ml-temporarily-hidden .c-virtual_list__item:has(.taut-ml-deleted),
      body.taut-ml-temporarily-hidden .c-message_kit__message:has(.taut-ml-deleted) {
        display: none !important;
      }

      body.taut-ml-temporarily-hidden .taut-ml-deleted--red,
      body.taut-ml-temporarily-hidden .taut-ml-deleted--red *,
      body.taut-ml-temporarily-hidden .c-message__body,
      body.taut-ml-temporarily-hidden .p-rich_text_section,
      body.taut-ml-temporarily-hidden .p-rich_text_block,
      body.taut-ml-temporarily-hidden [data-qa="message-text"] {
        color: inherit !important;
      }

      .taut-ml-vanished,
      .c-virtual_list__item.taut-ml-vanished,
      .c-message_kit__message.taut-ml-vanished,
      .c-virtual_list__item:has(.taut-ml-vanished),
      .c-message_kit__message:has(.taut-ml-vanished),
      [data-qa="message_container"]:has(.taut-ml-vanished),
      .c-message:has(.taut-ml-vanished) {
        display: none !important;
      }

      .c-menu_item__button--danger {
        color: var(--dt_color-content-negative, #e01e5a) !important;
      }

      .c-menu_item__button--danger.c-menu_item__button--highlighted {
        background-color: var(--dt_color-surf-negative-pri, #e01e5a) !important;
        color: #ffffff !important;
      }

      .c-menu_item__button--danger.c-menu_item__button--highlighted .c-menu_item__label {
        color: #ffffff !important;
      }
    `)

    this.api.rtm.on('message', (event) => {
      this.handleRtmMessage(event)
    })

    this.api.redux.patchSlice<object>('messages', (channelId, bucket) => {
      if (!bucket || typeof bucket !== 'object') return bucket
      return this.api.redux.mapEntries<SlackMessage>(bucket, (ts, msg) => {
        if (!msg) return msg
        if (this.isMessageVanished(channelId, ts)) {
          return undefined
        }
        const key = this.keyOf(channelId, ts)
        const deletedRecord =
          this.deleted.get(key) || this.deleted.get(this.keyOf('', ts))
        if (deletedRecord) {
          if (
            this.options.ignoreSelf !== false &&
            (this.isSelfDeleted(ts) ||
              this.isSelfMessage(ts) ||
              this.isSelfUser(deletedRecord.user as string | undefined))
          ) {
            setTimeout(() => {
              this.purgeSelfMessage(channelId, ts)
              this.scheduleSave()
            }, 0)
            return msg
          }
          return deletedRecord
        }

        let next = msg
        if (!next.channel) {
          next = { ...next, channel: channelId }
        }
        if (this.isSelfUser(next.user as string | undefined)) {
          this.markSelfMessage(ts)
        }
        this.rememberMessage(channelId, ts, next)
        return next
      })
    })

    this.api.redux.patchSlice<object>('threads', (channelId, threadBucket) => {
      if (!threadBucket || typeof threadBucket !== 'object') return threadBucket
      return this.api.redux.mapEntries<any>(
        threadBucket,
        (_threadTs, threadObj) => {
          if (!threadObj || typeof threadObj !== 'object') return threadObj
          if (Array.isArray(threadObj.replies)) {
            for (const reply of threadObj.replies) {
              if (reply?.ts) {
                if (this.isSelfUser(reply.user)) this.markSelfMessage(reply.ts)
                this.rememberMessage(channelId, reply.ts, reply)
              }
            }
          }
          if (threadObj.messages && typeof threadObj.messages === 'object') {
            for (const [mTs, mMsg] of Object.entries(
              threadObj.messages
            ) as any[]) {
              if (mMsg && mTs) {
                if (this.isSelfUser(mMsg.user)) this.markSelfMessage(mTs)
                this.rememberMessage(channelId, mTs, mMsg)
              }
            }
          }

          let nextThreadObj = threadObj
          if (Array.isArray(threadObj.replies)) {
            const filteredReplies = threadObj.replies.filter(
              (r: any) => !r?.ts || !this.isMessageVanished(channelId, r.ts)
            )
            if (filteredReplies.length !== threadObj.replies.length) {
              nextThreadObj = { ...nextThreadObj, replies: filteredReplies }
            }
          }
          if (threadObj.messages && typeof threadObj.messages === 'object') {
            let messagesChanged = false
            const nextMessages: Record<string, any> = {}
            for (const [mTs, mMsg] of Object.entries(threadObj.messages)) {
              if (this.isMessageVanished(channelId, mTs)) {
                messagesChanged = true
              } else {
                nextMessages[mTs] = mMsg
              }
            }
            if (messagesChanged) {
              nextThreadObj = { ...nextThreadObj, messages: nextMessages }
            }
          }
          return nextThreadObj
        }
      )
    })

    this.unpatchInject = this.api.messages.injectMessages(() => {
      const injected: SlackMessage[] = []
      for (const [key, msg] of this.deleted.entries()) {
        if (key.startsWith('*:')) continue
        const ts = msg.ts as string
        if (
          this.options.ignoreSelf !== false &&
          (this.isSelfDeleted(ts) ||
            this.isSelfMessage(ts) ||
            this.isSelfUser(msg.user as string | undefined))
        ) {
          continue
        }
        if (!this.isMessageVanished(msg.channel, ts)) {
          injected.push(msg)
        }
      }
      return injected
    })

    for (const name of [
      'MessageWrapper',
      'Message',
      'ThreadRootGeneric',
      'ActivityItem',
      'ThreadSenderAndTimestampGeneric',
      'BroadcastPreamble',
      'SearchResult',
    ]) {
      this.api.patchComponent<{ msg?: SlackMessage; message?: SlackMessage }>(
        name,
        (Original) => (props) => {
          const msg = props?.msg || props?.message
          const channel =
            (msg?.channel as string | undefined) || this.currentChannelId
          const ts = msg?.ts as string | undefined
          if (ts && this.isMessageVanished(channel, ts)) {
            return null
          }
          return (
            <this.MessageContext.Provider value={msg}>
              <Original {...props} />
            </this.MessageContext.Provider>
          )
        }
      )
    }

    this.api.patchComponent<BlocksProps>('Blocks', (Original) => (props) => {
      this.api.redux.usePatchVersion()
      if (this.isTemporarilyHidden) return <Original {...props} />
      const msg = props.msg
      const channel =
        (msg?.channel as string | undefined) || this.currentChannelId
      const ts = msg?.ts as string | undefined

      if (!ts) return <Original {...props} />

      if (msg) {
        this.rememberMessage(channel, ts, msg)
        if (this.isSelfUser(msg.user as string | undefined)) {
          this.markSelfMessage(ts)
          if (typeof msg.user === 'string') {
            this.selfUserIdsCache.add(msg.user)
          }
        }
      }

      const key = this.keyOf(channel, ts)
      const isSelf =
        this.options.ignoreSelf !== false &&
        (this.isSelfDeleted(ts) ||
          this.isSelfMessage(ts) ||
          this.isSelfUser(msg?.user as string | undefined))

      if (isSelf) {
        if (
          this.deleted.has(key) ||
          this.deleted.has(this.keyOf('', ts)) ||
          msg?.taut_deleted
        ) {
          this.purgeSelfMessage(channel, ts)
        }
        return <Original {...props} />
      }

      const isDeleted =
        Boolean(msg?.taut_deleted) ||
        this.deleted.has(key) ||
        this.deleted.has(this.keyOf('', ts))

      const isVanished = isDeleted && this.isMessageVanished(channel, ts)
      if (isVanished) {
        return null
      }

      const isClean = isDeleted && this.isCleanView(channel, ts)
      const showDeleted = isDeleted && !isClean

      const editList =
        this.edits.get(key) || this.edits.get(this.keyOf('', ts)) || []
      const isEdHidden = this.isEditsHidden(channel, ts)
      const showEdits = editList.length > 0 && !isEdHidden && !isClean

      if (!isDeleted && !showEdits) {
        return <Original {...props} />
      }

      const styleMode =
        this.options.deletedStyle === 'opacity' ? 'opacity' : 'red'
      const deletedClass = showDeleted
        ? ` taut-ml-deleted taut-ml-deleted--${styleMode}`
        : isClean
          ? ' taut-ml-clean'
          : ''
      const deletedAt =
        (msg as DeletedRecord | undefined)?.taut_deleted_at ||
        this.deleted.get(key)?.taut_deleted_at

      const { MrkdwnElement } = this.api.elements
      const hasBlocks = Array.isArray(msg?.blocks) && msg.blocks.length > 0
      const fallbackText = typeof msg?.text === 'string' ? msg.text : ''
      const files =
        Array.isArray((msg as any)?.files) && (msg as any).files.length > 0
          ? (msg as any).files
          : Array.isArray(this.deleted.get(key)?.files)
            ? (this.deleted.get(key)?.files as unknown[])
            : []

      return (
        <div
          className={`taut-ml-container${deletedClass}`}
          data-taut-ml-channel={channel}
          data-taut-ml-ts={ts}
        >
          {showDeleted && (
            <this.TombstoneNotice
              deletedAt={deletedAt}
              editCount={showEdits ? editList.length : 0}
              onDismiss={() => this.toggleCleanView(channel, ts)}
            />
          )}
          {hasBlocks ? (
            <Original {...props} />
          ) : fallbackText ? (
            <MrkdwnElement text={fallbackText} />
          ) : (
            <Original {...props} />
          )}
          {showDeleted && files.length > 0 && (
            <this.DeletedFilesCard files={files} />
          )}
          {showEdits && <this.EditHistorySection edits={editList} />}
        </div>
      )
    })

    for (const menuComp of [
      'MessageActionsMenu',
      'MessageActionsContextMenu',
      'MessageActionsOverflowMenu',
    ]) {
      this.api.patchComponent<{ ts?: string; channelId?: string }>(
        menuComp,
        (Original) => (props) => {
          if (props?.ts) {
            this.activeMenuMessage = {
              channel: props.channelId || this.currentChannelId,
              ts: props.ts,
            }
            requestAnimationFrame(() => this.checkMenus())
            setTimeout(() => this.checkMenus(), 25)
            setTimeout(() => this.checkMenus(), 75)
          }
          return <Original {...props} />
        }
      )
    }

    this.api.patchComponent<MenuFromTemplateProps>(
      'MenuFromTemplate',
      (Original) => (props) => {
        const template = props.template
        if (this.isTemporarilyHidden || !Array.isArray(template)) {
          return <Original {...props} />
        }

        const msgInfo =
          this.activeMenuMessage ||
          this.findMessageFromElement(
            typeof document !== 'undefined' ? document.activeElement : null
          ) ||
          (typeof document !== 'undefined' &&
          document.querySelector('.c-menu, [role="menu"]')
            ? this.getMessageFromFiber(
                document.querySelector('.c-menu, [role="menu"]')
              )
            : null)

        if (!msgInfo?.ts) {
          return <Original {...props} />
        }

        const channel = msgInfo.channel || this.currentChannelId
        const ts = msgInfo.ts
        const isDeleted = this.isMessageDeleted(channel, ts)
        const isEdited = this.isMessageEdited(channel, ts)

        if (!isDeleted && !isEdited) {
          return <Original {...props} />
        }

        if (template.some((item) => item?.key?.startsWith('taut-ml__'))) {
          return <Original {...props} />
        }

        const isClean = this.isCleanView(channel, ts)
        const isEdHidden = this.isEditsHidden(channel, ts)
        const extra: MenuTemplateItem[] = []

        if (isDeleted) {
          extra.push({
            key: 'taut-ml__delete',
            label: 'Delete message',
            icon: 'trash',
            click: () => this.vanishMessage(channel, ts),
          })
          extra.push({
            key: 'taut-ml__toggle-clean',
            label: isClean ? 'Show deletion notice' : 'Hide deletion notice',
            icon: isClean ? 'eye' : 'eye-slash',
            click: () => this.toggleCleanView(channel, ts),
          })
        }
        if (isEdited) {
          extra.push({
            key: 'taut-ml__toggle-edits',
            label: isEdHidden ? 'Show edit history' : 'Hide edit history',
            icon: isEdHidden ? 'eye' : 'eye-slash',
            click: () => this.toggleHideEdits(channel, ts),
          })
        }

        if (extra.length) {
          const next = [
            ...template,
            { key: 'taut-ml__separator', type: 'separator' as const },
            ...extra,
          ]
          return <Original {...props} template={next} />
        }

        return <Original {...props} />
      }
    )

    this.api.redux.refresh()
    this.log('Started')
  }

  stop() {
    if (this.fetchCleanup) {
      this.fetchCleanup()
      this.fetchCleanup = null
    }
    if (this.xhrCleanup) {
      this.xhrCleanup()
      this.xhrCleanup = null
    }
    if (this.keydownCleanup) {
      this.keydownCleanup()
      this.keydownCleanup = null
    }
    if (this.menuTrackingCleanup) {
      this.menuTrackingCleanup()
      this.menuTrackingCleanup = null
    }
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer)
      this.purgeTimer = null
    }
    if (this.unpatchInject) {
      this.unpatchInject()
      this.unpatchInject = null
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (typeof document !== 'undefined') {
      document.querySelectorAll('[data-taut-ml-menu]').forEach((el) => {
        const row = el.closest('li, .c-menu_item__li') || el
        row.remove()
      })
    }
    document.body.classList.remove('taut-ml-temporarily-hidden')
    void this.persistState()
    this.api.redux.refresh()
  }
}
