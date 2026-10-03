import { TautPlugin } from '$taut'

const BROADCAST_MARKER_RE =
  /<!(?:channel|here)(?:\|[^>]*)?>|@(?:channel|here)\b/i
const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])
const DENIED_BROADCASTS = new Set(['restricted_action'])
const COMPOSER_SELECTOR = [
  '[data-qa="texty_input"][contenteditable="true"]',
  '[data-qa="message_input"][contenteditable="true"]',
  '[data-qa="message-input"][contenteditable="true"]',
  '.c-wysiwyg_container [contenteditable="true"][role="textbox"]',
  '.p-message_input [contenteditable="true"][role="textbox"]',
  '.p-threads_footer [contenteditable="true"][role="textbox"]',
].join(',')

const READY_CHANNEL_TTL_MS = 60_000
const MANAGED_CHANNEL_TTL_MS = 5 * 60_000

const MIME_TYPES: Record<string, string> = {
  apng: 'image/apng',
  avif: 'image/avif',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
}

const DEFAULT_SERVICE_URL = 'https://bc.deployor.dev'

function requestUrl(input: any): string {
  return typeof input === 'string'
    ? input
    : (input?.url as string) || String(input)
}

function bodyRecord(body: any): Record<string, any> | null {
  if (!body) return null
  if (body instanceof URLSearchParams || body instanceof FormData) {
    const out: Record<string, any> = {}
    for (const [key, value] of body.entries())
      if (typeof value === 'string') out[key] = value
    return out
  }
  if (typeof body !== 'string') return null
  if (body.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(body)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : null
    } catch {
      return null
    }
  }
  return Object.fromEntries(new URLSearchParams(body))
}

function jsonArray(value: any): any[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function inferredMimeType(name: string): string {
  const ext = String(name).toLowerCase().split('.').pop() || ''
  return MIME_TYPES[ext] || 'application/octet-stream'
}

function imageMimeType(blob: Blob, name: string): string {
  const mimeType = String(blob?.type || inferredMimeType(name)).toLowerCase()
  if (!IMAGE_TYPES.has(mimeType)) {
    throw new Error(
      'bChannel can only send image attachments. Remove the other files and try again.'
    )
  }
  return mimeType
}

function broadcastKinds(value: any, out: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) broadcastKinds(item, out)
    return out
  }
  if (!value || typeof value !== 'object') return out
  if (
    value.type === 'broadcast' &&
    (value.range === 'channel' || value.range === 'here')
  )
    out.add(value.range)
  if (value.type === 'mrkdwn' && typeof value.text === 'string')
    textBroadcastKinds(value.text, out)
  for (const nested of Object.values(value)) broadcastKinds(nested, out)
  return out
}

function textBroadcastKinds(value: string, out: Set<string>): Set<string> {
  for (const match of String(value || '').matchAll(
    /<!(channel|here)(?:\|[^>]*)?>|(^|[^\w])@(channel|here)\b/gim
  )) {
    const kind = match[1] || match[3]
    if (kind === 'channel' || kind === 'here') out.add(kind)
  }
  return out
}

function composerMentionMatches(
  text: string
): Array<{ start: number; end: number; kind: string }> {
  const matches: Array<{ start: number; end: number; kind: string }> = []
  for (const match of String(text || '').matchAll(
    /(^|[^\p{L}\p{N}_])@(channel|here)\b/giu
  )) {
    const start = match.index + match[1].length
    matches.push({
      start,
      end: start + match[0].length - match[1].length,
      kind: match[2].toLowerCase(),
    })
  }
  return matches
}

function normalizeRestrictedBroadcasts(
  value: any,
  inCode = false,
  found: Set<string> = new Set()
): any {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const normalized = normalizeRestrictedBroadcasts(item, inCode, found)
      return Array.isArray(normalized) ? normalized : [normalized]
    })
  }
  if (!value || typeof value !== 'object') return value

  const code =
    inCode ||
    value.type === 'rich_text_preformatted' ||
    value.style?.code === true
  if (!code && value.type === 'text' && typeof value.text === 'string') {
    const matches = composerMentionMatches(value.text)
    if (matches.length) {
      const pieces: any[] = []
      let cursor = 0
      for (const match of matches) {
        if (match.start > cursor)
          pieces.push({ ...value, text: value.text.slice(cursor, match.start) })
        pieces.push({ type: 'broadcast', range: match.kind })
        found.add(match.kind)
        cursor = match.end
      }
      if (cursor < value.text.length)
        pieces.push({ ...value, text: value.text.slice(cursor) })
      return pieces
    }
  }

  const normalized: Record<string, any> = {}
  for (const [key, nested] of Object.entries(value)) {
    normalized[key] = normalizeRestrictedBroadcasts(nested, code, found)
  }
  return normalized
}

function normalizedBroadcastPayload(blocks: any[], text: string) {
  const restrictedKinds = new Set<string>()
  const normalizedBlocks = normalizeRestrictedBroadcasts(
    blocks,
    false,
    restrictedKinds
  )
  if (!blocks.length && !/<!(?:channel|here)(?:\|[^>]*)?>/i.test(text)) {
    textBroadcastKinds(text, restrictedKinds)
  }
  const kinds = broadcastKinds(normalizedBlocks, new Set<string>())
  if (!normalizedBlocks.length) textBroadcastKinds(text, kinds)
  return {
    blocks: normalizedBlocks,
    kinds,
    requiresHandoff: restrictedKinds.size > 0,
  }
}

function fileReferences(
  value: any,
  out: Map<string, string> = new Map()
): Map<string, string> {
  if (Array.isArray(value)) {
    for (const item of value) fileReferences(item, out)
    return out
  }
  if (!value || typeof value !== 'object') return out
  if (
    value.type === 'file' &&
    /^F[A-Z0-9]+$/.test(String(value.file_id || ''))
  ) {
    out.set(String(value.file_id), String(value.text || ''))
  }
  for (const nested of Object.values(value)) fileReferences(nested, out)
  return out
}

function teamIdFrom(values: Record<string, any>): { teamId?: string } {
  return typeof values.client_context_team_id === 'string' &&
    /^[TE][A-Z0-9]+$/.test(values.client_context_team_id)
    ? { teamId: values.client_context_team_id }
    : {}
}

function isChannelConversation(channelId: string): boolean {
  return /^[CG][A-Z0-9]+$/.test(String(channelId || ''))
}

function candidateFromBody(body: any): any {
  const values = bodyRecord(body)
  if (!values) return null
  const rawText = typeof values.text === 'string' ? values.text : ''
  const rawBlocks = typeof values.blocks === 'string' ? values.blocks : ''
  if (!rawText && !rawBlocks) return null
  if (
    !BROADCAST_MARKER_RE.test(rawText) &&
    !BROADCAST_MARKER_RE.test(rawBlocks)
  )
    return null
  const channelId = String(values.channel || '')
  const token = String(values.token || '')
  const blocks = jsonArray(values.blocks)
  const text = typeof values.text === 'string' ? values.text : ''
  const normalized = normalizedBroadcastPayload(blocks, text)
  const kinds = normalized.kinds
  if (!kinds.size || !/^[CG][A-Z0-9]+$/.test(channelId) || !token) return null
  const threadTs =
    typeof values.thread_ts === 'string' &&
    /^\d{1,16}\.\d{1,16}$/.test(values.thread_ts)
      ? values.thread_ts
      : undefined
  const uploads = [...fileReferences(blocks)].map(([sourceId, title]) => ({
    sourceId,
    name: title || 'attachment',
  }))
  return {
    token,
    requiresHandoff: normalized.requiresHandoff,
    dedupe: String(
      values.client_msg_id ||
        `${channelId}:${threadTs || ''}:${text}:${JSON.stringify(blocks)}`
    ),
    uploads,
    intent: {
      version: 1,
      channelId,
      ...teamIdFrom(values),
      text,
      blocks: normalized.blocks,
      ...(threadTs ? { threadTs } : {}),
      ...(values.unfurl_links === 'false' || values.unfurl_links === false
        ? { unfurlLinks: false }
        : {}),
      ...(values.unfurl_media === 'false' || values.unfurl_media === false
        ? { unfurlMedia: false }
        : {}),
    },
  }
}

function candidateFromFileCompletion(body: any): any {
  const values = bodyRecord(body)
  if (!values) return null
  const rawText = String(values.initial_comment || values.text || '')
  const rawBlocks = typeof values.blocks === 'string' ? values.blocks : ''
  if (!rawText && !rawBlocks) return null
  if (
    !BROADCAST_MARKER_RE.test(rawText) &&
    !BROADCAST_MARKER_RE.test(rawBlocks)
  )
    return null
  const channelId = String(values.channel_id || values.channel || '')
  const token = String(values.token || '')
  const blocks = jsonArray(values.blocks)
  const text = String(values.initial_comment || values.text || '')
  const normalized = normalizedBroadcastPayload(blocks, text)
  const kinds = normalized.kinds
  const files = jsonArray(values.files)
    .map((file) => ({
      id: String(file?.id || ''),
      title: String(file?.title || ''),
    }))
    .filter((file) => /^F[A-Z0-9]+$/.test(file.id))
  if (
    !kinds.size ||
    !files.length ||
    !/^[CG][A-Z0-9]+$/.test(channelId) ||
    !token
  )
    return null
  const threadTs = /^\d{1,16}\.\d{1,16}$/.test(String(values.thread_ts || ''))
    ? String(values.thread_ts)
    : undefined
  const uploads = files.map((file) => ({
    sourceId: file.id,
    name: file.title || 'attachment',
  }))
  return {
    token,
    requiresHandoff: normalized.requiresHandoff,
    dedupe: `${channelId}:${threadTs || ''}:${files.map((file) => file.id).join(',')}:${text}:${JSON.stringify(blocks)}`,
    uploads,
    intent: {
      version: 1,
      channelId,
      ...teamIdFrom(values),
      text,
      blocks: normalized.blocks,
      ...(threadTs ? { threadTs } : {}),
    },
  }
}

function candidateFromDelete(body: any): any {
  const values = bodyRecord(body)
  if (!values) return null
  const channelId = String(values.channel || '')
  const ts = String(values.ts || '')
  if (!/^[CG][A-Z0-9]+$/.test(channelId) || !/^\d{1,16}\.\d{1,16}$/.test(ts))
    return null
  return {
    token: String(values.token || ''),
    channelId,
    ts,
    dedupe: `${channelId}:${ts}`,
    ...teamIdFrom(values),
  }
}

function responseData(response: any): any {
  try {
    return response && typeof response === 'object'
      ? response
      : JSON.parse(String(response || '{}'))
  } catch {
    return {}
  }
}

function deltaBroadcastKinds(delta: any): Set<string> {
  const kinds = new Set<string>()
  for (const op of Array.isArray(delta?.ops) ? delta.ops : []) {
    const id = op?.attributes?.slackmention?.id
    if (id === 'BKchannel') kinds.add('channel')
    if (id === 'BKhere') kinds.add('here')
  }
  return kinds
}

function deltaCandidateKinds(delta: any): Set<string> {
  const kinds = deltaBroadcastKinds(delta)
  let searchable = ''
  for (const op of Array.isArray(delta?.ops) ? delta.ops : []) {
    if (typeof op?.insert !== 'string') continue
    const mention = op?.attributes?.slackmention
    if (mention) {
      searchable +=
        mention.id === 'BKchannel' || mention.id === 'BKhere' ? op.insert : ' '
      continue
    }
    if (op.attributes?.code === true || op.attributes?.['code-block'])
      searchable += ' '
    else searchable += op.insert
  }
  textBroadcastKinds(searchable, kinds)
  return kinds
}

function plainTextFromDelta(delta: any): string {
  return (Array.isArray(delta?.ops) ? delta.ops : [])
    .map((op: any) => {
      if (typeof op?.insert === 'string') return op.insert
      const mention = op?.attributes?.slackmention
      return typeof mention?.label === 'string' ? mention.label : ''
    })
    .join('')
    .replace(/\n$/, '')
}

function reactFiber(node: Element): any {
  for (
    let current: Element | null = node;
    current;
    current = current.parentElement
  ) {
    const key = Object.keys(current).find((name) =>
      name.startsWith('__reactFiber$')
    )
    if (key) return (current as any)[key]
  }
  return null
}

function componentName(fiber: any): string {
  return (
    fiber?.stateNode?.constructor?.displayName ||
    fiber?.stateNode?.constructor?.name ||
    fiber?.type?.displayName ||
    fiber?.type?.name
  )
}

function componentFromFiber(fiber: any, name: string): any {
  for (let current = fiber; current; current = current.return) {
    if (componentName(current) === name && current.stateNode)
      return current.stateNode
  }
  return null
}

function composerAttachmentRoot(composer: Element): Element | Document {
  return (
    composer?.closest?.(
      '.p-message_pane_input, .p-message_input, .p-threads_footer, [data-qa="message_input_container"], [data-qa="message_input"]'
    ) ||
    composer?.parentElement?.parentElement ||
    document
  )
}

function draftImageFromDom(
  fileId: string,
  root: Element | Document = document
): any {
  if (!/^F[A-Z0-9]+$/.test(String(fileId || ''))) return null
  for (const button of Array.from(
    root.querySelectorAll?.('[aria-describedby^="draft-image-file-name-F"]') ||
      []
  )) {
    const labelId = String(button.getAttribute?.('aria-describedby') || '')
    if (labelId !== `draft-image-file-name-${fileId}`) continue
    const image = button.querySelector?.(
      'img[data-qa="file_thumbnail_img"]'
    ) as HTMLImageElement | null
    const name = String(
      document.getElementById?.(labelId)?.textContent || image?.alt || ''
    ).trim()
    let thumbnail: URL | undefined
    try {
      thumbnail = new URL(String(image?.src || ''))
    } catch {}
    const match = thumbnail?.pathname.match(
      /^\/files-tmb\/([TE][A-Z0-9]+)-(F[A-Z0-9]+)-[^/]+\//
    )
    if (
      !name ||
      name.length > 255 ||
      thumbnail?.protocol !== 'https:' ||
      !(
        thumbnail.hostname === 'slack.com' ||
        thumbnail.hostname.endsWith('.slack.com')
      ) ||
      match?.[2] !== fileId
    )
      return null
    return {
      sourceId: fileId,
      name,
      mimeType: inferredMimeType(name),
      privateUrl: `https://files.slack.com/files-pri/${match[1]}-${match[2]}/${encodeURIComponent(name)}`,
    }
  }
  return null
}

function draftImageIdsFromDom(root: Element | Document = document): string[] {
  const ids: string[] = []
  for (const button of Array.from(
    root.querySelectorAll?.('[aria-describedby^="draft-image-file-name-F"]') ||
      []
  )) {
    const match = String(button.getAttribute?.('aria-describedby') || '').match(
      /^draft-image-file-name-(F[A-Z0-9]+)$/
    )
    if (match && draftImageFromDom(match[1], root)) ids.push(match[1])
  }
  return [...new Set(ids)]
}

function commandDelta(delta: any, commandText: string): any {
  const text = `/bchannel ${commandText}`
  const Delta = delta?.constructor
  if (typeof Delta !== 'function') return { ops: [{ insert: `${text}\n` }] }
  try {
    const command = new Delta()
    if (typeof command.insert === 'function')
      return command.insert(text).insert('\n')
    return new Delta([{ insert: `${text}\n` }])
  } catch {
    return { ops: [{ insert: `${text}\n` }] }
  }
}

function blocksWithUploads(blocks: any[], uploads: any[]): any[] {
  if (!uploads.length) return blocks
  let section: any
  for (const block of blocks) {
    if (block?.type !== 'rich_text' || !Array.isArray(block.elements)) continue
    section = block.elements.find(
      (element: any) =>
        element?.type === 'rich_text_section' && Array.isArray(element.elements)
    )
    if (section) break
  }
  if (!section) {
    section = { type: 'rich_text_section', elements: [] }
    blocks.push({ type: 'rich_text', elements: [section] })
  }
  for (const upload of uploads) {
    section.elements.push({
      type: 'file',
      file_id: upload.sourceId,
      text: upload.name,
    })
  }
  return blocks
}

function notificationTextFromBlocks(blocks: any[], fallback: string): string {
  const neutralize = (value: string) =>
    String(value || '')
      .replace(
        /<!(channel|here)(?:\|[^>]*)?>/gi,
        (_match, kind) => `@\u200b${kind.toLowerCase()}`
      )
      .replace(
        /@(channel|here)\b/gi,
        (_match, kind) => `@\u200b${kind.toLowerCase()}`
      )
  const render = (value: any): string => {
    if (Array.isArray(value)) return value.map(render).join('')
    if (!value || typeof value !== 'object') return ''
    if (
      value.type === 'broadcast' &&
      (value.range === 'channel' || value.range === 'here')
    ) {
      return `@${value.range}`
    }
    if (value.type === 'text' && typeof value.text === 'string')
      return neutralize(value.text)
    if (value.type === 'user' && typeof value.user_id === 'string')
      return `<@${value.user_id}>`
    if (value.type === 'channel' && typeof value.channel_id === 'string')
      return `<#${value.channel_id}>`
    if (value.type === 'emoji' && typeof value.name === 'string')
      return `:${value.name}:`
    if (value.type === 'link' && typeof value.url === 'string') {
      return typeof value.text === 'string' && value.text !== value.url
        ? `<${value.url}|${value.text}>`
        : `<${value.url}>`
    }
    if (value.type === 'mrkdwn' && typeof value.text === 'string')
      return neutralize(value.text)
    if (value.type === 'rich_text_list' && Array.isArray(value.elements)) {
      return value.elements.map(render).join('\n')
    }
    if (Array.isArray(value.elements)) {
      return value.elements
        .map(render)
        .join(value.type === 'rich_text' ? '\n' : '')
    }
    return ''
  }
  const structural = blocks
    .map(render)
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return (structural || neutralize(fallback)).slice(0, 40000)
}

function prefAllowsBot(pref: any, botUserId: string): boolean {
  const value = pref?.pref_value
  if (!value || typeof value !== 'object') return true
  const types = Array.isArray(value.type) ? value.type.map(String) : []
  const users = Array.isArray(value.user) ? value.user.map(String) : []
  if (users.includes(botUserId)) return true
  return !types.some((type: string) =>
    ['admin', 'owner', 'org_admin'].includes(type)
  )
}

function postingPrefWithBot(pref: any, botUserId: string): string {
  const value = pref?.pref_value
  if (!value || typeof value !== 'object') return ''
  const parts: string[] = []
  for (const type of Array.isArray(value.type) ? value.type : [])
    parts.push(`type:${String(type)}`)
  for (const user of Array.isArray(value.user) ? value.user : [])
    parts.push(`user:${String(user)}`)
  for (const subteam of Array.isArray(value.subteam) ? value.subteam : [])
    parts.push(`subteam:${String(subteam)}`)
  if (!parts.includes(`user:${botUserId}`)) parts.push(`user:${botUserId}`)
  return parts.join(',')
}

function setupBotId(staged: any): string {
  const id = String(staged?.setup?.botUserId || '')
  return /^U[A-Z0-9]+$/.test(id) ? id : ''
}

function waitForSlack(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    const timer = (window.setTimeout || setTimeout)(resolve, milliseconds)
    if (!signal) return
    if (signal.aborted) {
      clearTimeout(timer)
      resolve()
      return
    }
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function slackPropagationDelay(attempt: number): number {
  return attempt <= 2 ? 500 : 2_000
}

export default class bChannel extends TautPlugin {
  static readonly id = 'bChannel'
  static readonly pluginName = 'bChannel'
  static readonly description =
    'Lets you @channel and @here from the composer, powered by /bchannel'
  static readonly authors = '<@U078PH0GBEH>'
  static readonly defaultConfig = `
    "bChannel": {
      "enabled": true,
      "serviceUrl": "https://bc.deployor.dev"
    }
  `

  private handled = new Map<string, number>()
  private handoffsInFlight = new Map<string, Promise<unknown>>()
  private readyChannels = new Map<string, number>()
  private setupCache = new Map<
    string,
    { botUserId: string; expiresAt: number }
  >()
  private readinessChecksInFlight = new Map<string, Promise<void>>()
  private managedChannels = new Map<string, number>()
  private composerState = new WeakMap<Element, any>()
  private slackRequire: any = null
  private slackSerializer: any = null
  private nativeFetch = window.fetch.bind(window)
  private originalFetch: typeof window.fetch | null = null
  private originalXHROpen: typeof XMLHttpRequest.prototype.open | null = null
  private originalXHRSend: typeof XMLHttpRequest.prototype.send | null = null
  private observer: MutationObserver | null = null
  private composerFrame = 0
  private evictionTimer: number | null = null
  private upgradeFromEvent: ((event: Event) => void) | null = null

  private serviceUrl(): string {
    const configured = String(
      this.config.serviceUrl || DEFAULT_SERVICE_URL
    ).trim()
    try {
      const url = new URL(configured)
      if (
        url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(url.hostname))
      ) {
        return url.origin
      }
    } catch {}
    return DEFAULT_SERVICE_URL
  }

  private fetchSignal(timeoutMs: number): AbortSignal {
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([this.api.signal, AbortSignal.timeout(timeoutMs)])
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      controller.abort()
    }
    if (this.api.signal.aborted) controller.abort()
    else this.api.signal.addEventListener('abort', onAbort, { once: true })
    return controller.signal
  }

  private getSlackRequire(): any {
    if (this.slackRequire) return this.slackRequire
    const w = window as any
    if (typeof w.__webpack_require__ === 'function') {
      this.slackRequire = w.__webpack_require__
      return this.slackRequire
    }
    throw new Error("Slack's message formatter is not available yet.")
  }

  private getSlackSerializer(): any {
    if (this.slackSerializer) return this.slackSerializer
    const runtimeRequire = this.getSlackRequire()
    let known: any
    try {
      known = runtimeRequire('DiPi')
    } catch {}
    if (typeof known?.A === 'function') this.slackSerializer = known.A
    if (!this.slackSerializer) {
      for (const [id, factory] of Object.entries(runtimeRequire.m || {})) {
        if (!String(factory).includes('convertDeltaToBlocks')) continue
        const exports = runtimeRequire(id)
        const candidate = Object.values(exports || {}).find(
          (value: any) => typeof value === 'function'
        )
        if (candidate) {
          this.slackSerializer = candidate
          break
        }
      }
    }
    if (!this.slackSerializer)
      throw new Error(
        "This Slack version's message formatter is not supported yet."
      )
    return this.slackSerializer
  }

  private blocksFromDelta(delta: any, store: any): any[] {
    const result = this.getSlackSerializer()({ delta, state: store.getState() })
    if (!Array.isArray(result?.blocks))
      throw new Error('Slack could not format this message for bChannel.')
    return result.blocks
  }

  private currentSlackStore(): any {
    return this.api.redux.getStore()
  }

  private async preflightBotId(teamId: string): Promise<string> {
    if (!/^[TE][A-Z0-9]+$/.test(String(teamId || ''))) return ''
    const cached = this.setupCache.get(teamId)
    if (cached && cached.expiresAt > Date.now()) return cached.botUserId
    try {
      const response = await this.nativeFetch(
        `${this.serviceUrl()}/slick/preflight`,
        {
          method: 'POST',
          credentials: 'omit',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          },
          body: new URLSearchParams({ teamId }),
          signal: this.fetchSignal(5_000),
        }
      )
      const result = await response.json().catch(() => ({}))
      const botUserId =
        response.ok &&
        /^U[A-Z0-9]+$/.test(String(result?.setup?.botUserId || ''))
          ? String(result.setup.botUserId)
          : ''
      this.setupCache.set(teamId, {
        botUserId,
        expiresAt: Date.now() + (botUserId ? 5 * 60_000 : 30_000),
      })
      return botUserId
    } catch {
      return ''
    }
  }

  private async warmChannelReadiness(
    teamId: string,
    channelId: string,
    store: any
  ) {
    if (
      !store?.dispatch ||
      !store?.getState ||
      !isChannelConversation(channelId)
    )
      return
    const botUserId = await this.preflightBotId(teamId)
    if (!botUserId) return
    const cacheKey = `${botUserId}:${channelId}`
    if (
      Date.now() - (this.readyChannels.get(cacheKey) || 0) <
      READY_CHANNEL_TTL_MS
    )
      return
    if (this.readinessChecksInFlight.has(cacheKey))
      return this.readinessChecksInFlight.get(cacheKey)
    const check = (async () => {
      try {
        if (this.api.signal.aborted) return
        const runtimeRequire = this.getSlackRequire()
        const membership = await runtimeRequire('eh+y').qY(
          store.dispatch,
          store.getState,
          channelId,
          [botUserId]
        )
        if (membership?.[botUserId] !== true) return
        const current = await store.dispatch(
          runtimeRequire('M9P0').Kn({
            channelId,
            prefName: 'who_can_post',
            reason: 'taut-bchannel-preflight-posting-permissions',
          })
        )
        if (prefAllowsBot(current, botUserId))
          this.readyChannels.set(cacheKey, Date.now())
      } catch {}
    })()
    this.readinessChecksInFlight.set(cacheKey, check)
    try {
      await check
    } finally {
      if (this.readinessChecksInFlight.get(cacheKey) === check)
        this.readinessChecksInFlight.delete(cacheKey)
    }
  }

  private isManagedChannel(channelId: string): boolean {
    const seenAt = this.managedChannels.get(String(channelId || '')) || 0
    if (Date.now() - seenAt < MANAGED_CHANNEL_TTL_MS) return true
    if (seenAt) this.managedChannels.delete(String(channelId || ''))
    return false
  }

  private isBChannelMessage(channelId: string, ts: string): boolean {
    const store = this.currentSlackStore()
    const msg = store?.getState().messages?.[channelId]?.[ts]
    if (msg?.metadata?.event_type === 'bchannel_message') return true
    return msg?.bot_id === 'B0BJDMND6HX'
  }

  private async slackPrivateFileMetadata(
    fileId: string,
    root: Element | Document
  ): Promise<any> {
    const draftFile = draftImageFromDom(fileId, root)
    if (!draftFile || !IMAGE_TYPES.has(draftFile.mimeType)) return null
    let response: Response
    try {
      response = await this.nativeFetch(draftFile.privateUrl, {
        method: 'HEAD',
        credentials: 'include',
        redirect: 'follow',
        signal: this.fetchSignal(15000),
      })
    } catch {
      return null
    }
    const mimeType = String(
      response.headers.get('content-type') || draftFile.mimeType
    )
      .split(';', 1)[0]
      .toLowerCase()
    const size = Number(response.headers.get('content-length') || 0)
    if (
      !response.ok ||
      !IMAGE_TYPES.has(mimeType) ||
      !Number.isSafeInteger(size) ||
      size <= 0
    )
      return null
    return { ...draftFile, mimeType, size }
  }

  private async nativeUploads(
    args: any,
    store: any,
    composer?: Element
  ): Promise<any[]> {
    const root = composerAttachmentRoot(composer as Element)
    const requestedIds = new Set<string>(
      Array.isArray(args?.fileIds) ? args.fileIds.map(String) : []
    )
    const liveDocumentIds = draftImageIdsFromDom(document)
    const visibleImageIds = requestedIds.size
      ? liveDocumentIds.filter((fileId) => requestedIds.has(fileId))
      : draftImageIdsFromDom(root)
    const persistedIds = new Set<string>(
      visibleImageIds.length
        ? visibleImageIds
        : Array.isArray(args?.fileIds)
          ? args.fileIds.map(String)
          : []
    )
    const pendingIds = new Set<string>(
      visibleImageIds.length
        ? []
        : Array.isArray(args?.pendingFileIds)
          ? args.pendingFileIds.map(String)
          : []
    )
    if (!persistedIds.size && !pendingIds.size) return []
    const slackState: any = store.getState() || {}
    const pending: Record<string, any> = slackState.pendingFileUploads || {}
    const files: Record<string, any> = slackState.files || {}
    const uploads: any[] = []
    const seen = new Set<string>()
    const matchedPersisted = new Set<string>()
    const matchedPending = new Set<string>()
    const appendUpload = (
      sourceId: string,
      nameHint: string,
      mimeTypeValue: string,
      sizeValue: number,
      loadBlob: () => Promise<Blob>
    ) => {
      if (seen.has(sourceId)) return
      const name = String(nameHint || 'attachment').slice(0, 255)
      const mimeType = String(
        mimeTypeValue || inferredMimeType(name)
      ).toLowerCase()
      const size = Number(sizeValue || 0)
      if (!IMAGE_TYPES.has(mimeType)) {
        throw new Error(
          'bChannel can only send image attachments. Remove the other files and try again.'
        )
      }
      if (
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        typeof loadBlob !== 'function'
      )
        return
      const slot = window.crypto.randomUUID()
      seen.add(sourceId)
      uploads.push({
        sourceId,
        name,
        slot,
        loadBlob,
        descriptor: { sourceId, name, slot, mimeType, size },
      })
    }
    const downloadImage = async (
      url: string,
      name: string,
      expectedMime: string,
      expectedSize: number
    ) => {
      const response = await this.nativeFetch(url, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
        signal: this.fetchSignal(120000),
      })
      if (!response.ok) throw new Error(`Slack couldn't retrieve ${name}.`)
      const blob = await response.blob()
      const mimeType = imageMimeType(blob, name)
      if (
        mimeType !== String(expectedMime || '').toLowerCase() ||
        blob.size !== Number(expectedSize || 0)
      ) {
        throw new Error(
          'Slack returned attachment bytes that did not match the selected image.'
        )
      }
      return blob
    }
    for (const [pendingId, entry] of Object.entries(pending)) {
      const persistedId = String(entry?.persistedFileId || '')
      if (!pendingIds.has(pendingId) && !persistedIds.has(persistedId)) continue
      const sourceId = /^F[A-Z0-9]+$/.test(persistedId)
        ? persistedId
        : `FTAUT${window.crypto.randomUUID().replace(/-/g, '').toUpperCase()}`
      const file = entry?.file
      if (file instanceof Blob) {
        const uploadFile = file as File
        appendUpload(
          sourceId,
          uploadFile.name || entry?.name,
          uploadFile.type,
          uploadFile.size,
          async () => uploadFile
        )
      }
      if (seen.has(sourceId)) {
        if (persistedIds.has(persistedId)) matchedPersisted.add(persistedId)
        if (pendingIds.has(pendingId)) matchedPending.add(pendingId)
      }
    }
    for (const persistedId of persistedIds) {
      if (matchedPersisted.has(persistedId)) continue
      const file = files[persistedId]
      const privateUrl = String(
        file?.url_private_download || file?.url_private || ''
      )
      let parsedUrl: URL | undefined
      try {
        parsedUrl = new URL(privateUrl)
      } catch {}
      const trustedUrl =
        parsedUrl?.protocol === 'https:' &&
        (parsedUrl.hostname === 'slack.com' ||
          parsedUrl.hostname.endsWith('.slack.com'))
      if (
        file &&
        file.mode !== 'tombstone' &&
        file.is_deleted !== true &&
        trustedUrl
      ) {
        appendUpload(
          persistedId,
          file.name || file.title,
          file.mimetype,
          file.size,
          () =>
            downloadImage(
              privateUrl,
              file.name || file.title || 'this image',
              file.mimetype,
              file.size
            )
        )
      }
      if (seen.has(persistedId)) matchedPersisted.add(persistedId)
    }
    for (const persistedId of persistedIds) {
      if (matchedPersisted.has(persistedId)) continue
      const file = await this.slackPrivateFileMetadata(persistedId, document)
      if (!file) continue
      appendUpload(file.sourceId, file.name, file.mimeType, file.size, () =>
        downloadImage(file.privateUrl, file.name, file.mimeType, file.size)
      )
      if (seen.has(persistedId)) matchedPersisted.add(persistedId)
    }
    if (
      persistedIds.size > 0 &&
      matchedPersisted.size === persistedIds.size &&
      pendingIds.size <= persistedIds.size &&
      uploads.length === persistedIds.size
    ) {
      for (const pendingId of pendingIds) matchedPending.add(pendingId)
    }
    if (
      matchedPersisted.size !== persistedIds.size ||
      matchedPending.size !== pendingIds.size
    ) {
      throw new Error(
        matchedPersisted.size || matchedPending.size
          ? 'This draft contains an attachment Slack no longer has. Remove any "Hidden file" attachment, then try again.'
          : 'Slack no longer has the bytes for one or more attachments. Remove and attach those files again.'
      )
    }
    return uploads
  }

  private clearPendingFileUploads(store: any, pendingIds: Set<string>) {
    if (!pendingIds.size || !store?.dispatch) return
    let runtimeRequire: any
    try {
      runtimeRequire = this.getSlackRequire()
    } catch {
      return
    }
    // dig out the module that owns pendingFileUploads, same as the serializer
    for (const [id, factory] of Object.entries(runtimeRequire.m || {})) {
      const source = String(factory)
      if (!source.includes('pendingFileUploads')) continue
      const exports = runtimeRequire(id)
      const candidate = Object.values(exports || {}).find(
        (value: any) =>
          typeof value === 'function' &&
          /removePending|clearPending|deletePending/i.test(String(value))
      )
      if (!candidate) continue
      const remove = candidate as (id: string) => unknown
      for (const pendingId of pendingIds) {
        try {
          store.dispatch(remove(pendingId))
        } catch {}
      }
      return
    }
  }

  private async uploadStagedFiles(token: string, uploads: any[]) {
    for (const upload of uploads) {
      let blob: Blob
      try {
        blob = await upload.loadBlob()
      } catch (error) {
        throw error instanceof Error
          ? error
          : new Error(`Slack couldn't retrieve ${upload.name}.`)
      }
      if (!(blob instanceof Blob) || blob.size !== upload.descriptor.size) {
        throw new Error('Slack returned an incomplete attachment.')
      }
      let lastFailure: string | null = null
      for (let attempt = 1; attempt <= 10; attempt++) {
        if (this.api.signal.aborted)
          throw new Error('bChannel was disabled while sending.')
        let response: Response
        try {
          response = await this.nativeFetch(
            `${this.serviceUrl()}/slick/intents/${encodeURIComponent(token)}/files/${upload.slot}`,
            {
              method: 'PUT',
              credentials: 'omit',
              headers: { 'content-type': upload.descriptor.mimeType },
              body: blob,
              signal: this.fetchSignal(120000),
            }
          )
        } catch (error) {
          lastFailure = `Slack didn't confirm whether ${upload.name} finished uploading.`
          if (attempt < 10) {
            await waitForSlack(slackPropagationDelay(attempt), this.api.signal)
            continue
          }
          throw new Error(lastFailure, { cause: error })
        }
        if (response.ok) {
          lastFailure = null
          break
        }
        const failure = await response.json().catch(() => ({}))
        lastFailure = String(
          failure.message || `bChannel couldn't upload ${upload.name}.`
        )
        if (
          attempt < 10 &&
          (response.status === 404 ||
            response.status === 409 ||
            response.status === 429)
        ) {
          await waitForSlack(slackPropagationDelay(attempt), this.api.signal)
          continue
        }
        throw new Error(lastFailure)
      }
      if (lastFailure) throw new Error(lastFailure)
    }
  }

  private async prepareNativeHandoff(original: any, args: any, meta: any) {
    const kinds = deltaCandidateKinds(args?.delta)
    if (!meta.managed || !meta.eligible || !kinds.size)
      return original.call(undefined, args)
    if (!meta.store)
      throw new Error(
        "Slack's workspace state is not available yet. Try sending again."
      )

    const dedupe = `${String(args.channelId || '')}:${String(args.threadTs || '')}:${String(args.draftId || '')}:${JSON.stringify(args.delta.ops)}`
    const existing = this.handoffsInFlight.get(dedupe)
    if (existing) return existing

    const run = (async () => {
      let uploads: any[] | undefined
      let uploadError: unknown
      for (let attempt = 1; attempt <= 10; attempt++) {
        if (this.api.signal.aborted)
          throw new Error('bChannel was disabled while sending.')
        try {
          uploads = await this.nativeUploads(args, meta.store, meta.composer)
          uploadError = null
          break
        } catch (error) {
          uploadError = error
          const requestedFileIds = new Set(
            Array.isArray(args?.fileIds) ? args.fileIds.map(String) : []
          )
          const visibleRequestedImage = draftImageIdsFromDom(document).some(
            (fileId) => requestedFileIds.has(fileId)
          )
          const uploadMayStillBeResolving =
            visibleRequestedImage ||
            (Array.isArray(args?.pendingFileIds) &&
              args.pendingFileIds.length > 0)
          if (
            attempt >= 10 ||
            !uploadMayStillBeResolving ||
            !/attachment Slack no longer has|Slack no longer has the bytes/i.test(
              String((error as Error)?.message)
            )
          ) {
            throw error
          }
          await waitForSlack(slackPropagationDelay(attempt), this.api.signal)
        }
      }
      if (!uploads)
        throw (
          uploadError ||
          new Error('Slack could not resolve the selected attachments.')
        )
      const normalizedKinds = new Set<string>()
      const nativeBlocks = this.blocksFromDelta(args.delta, meta.store)
      const blocks = blocksWithUploads(
        normalizeRestrictedBroadcasts(nativeBlocks, false, normalizedKinds),
        uploads
      )
      if (!broadcastKinds(blocks, new Set<string>()).size) {
        throw new Error(
          'Slack could not recognize the @channel or @here mention in this message.'
        )
      }
      const intent = {
        version: 1,
        channelId: String(args.channelId || ''),
        ...(typeof meta?.teamId === 'string' &&
        /^[TE][A-Z0-9]+$/.test(meta.teamId)
          ? { teamId: meta.teamId }
          : {}),
        text: notificationTextFromBlocks(
          blocks,
          plainTextFromDelta(args.delta)
        ),
        blocks,
        ...(typeof args.threadTs === 'string' && args.threadTs
          ? { threadTs: args.threadTs }
          : {}),
        ...(uploads.length
          ? { files: uploads.map((upload) => upload.descriptor) }
          : {}),
      }
      let staged = await this.stageIntent(intent)

      try {
        if (
          await this.ensureBChannelReady(
            staged,
            meta.store,
            String(args.channelId || '')
          )
        ) {
          await this.discardIntent(staged.token)
          staged = await this.stageIntent(intent)
        }
        const result = await original.call(undefined, {
          ...args,
          delta: commandDelta(args.delta, staged.commandText),
          fileIds: [],
          pendingFileIds: [],
          unfurls: [],
          includeBroadcastKeywordWarning: false,
        })
        await this.uploadStagedFiles(staged.token, uploads)
        this.clearPendingFileUploads(
          meta.store,
          new Set(
            Array.isArray(args?.pendingFileIds)
              ? args.pendingFileIds.map(String)
              : []
          )
        )
        return result
      } catch (error) {
        await this.discardIntent(staged.token)
        throw error
      }
    })()
    this.handoffsInFlight.set(dedupe, run)
    try {
      return await run
    } finally {
      if (this.handoffsInFlight.get(dedupe) === run)
        this.handoffsInFlight.delete(dedupe)
    }
  }

  private upgradeComposer(composer: Element) {
    const container =
      composer.closest?.('.ql-container') || composer.parentElement
    const quill = (container as any)?.__quill
    if (!quill || typeof quill.getModule !== 'function') return

    let meta = this.composerState.get(composer)
    if (!meta) {
      const fiber = reactFiber(container || composer)
      if (!fiber) return
      const autocomplete = componentFromFiber(fiber, 'TextyAutocomplete')
      const pane = componentFromFiber(fiber, 'MessagePaneInput')
      if (!autocomplete?.props) return
      const originallyEnabled =
        autocomplete.props.includeAllBroadcastKeywords === true
      meta = {
        managed: !originallyEnabled,
        eligible: false,
        store: this.currentSlackStore(),
        composer,
        autocomplete,
        pane,
        dirty: true,
      }
      this.composerState.set(composer, meta)
      try {
        quill.on?.('text-change', () => {
          meta.dirty = true
        })
      } catch {
        // noop
      }
    } else if (!meta.store) {
      meta.store = this.currentSlackStore()
    }
    meta.composer = composer
    meta.quill = quill

    const pane = meta.pane
    const autocomplete = meta.autocomplete
    const channelId = String(pane?.props?.channelId || '')
    const teamId = String(pane?.props?.teamId || '')
    const eligible = isChannelConversation(channelId)
    const channelChanged = meta.channelId !== channelId
    meta.channelId = channelId
    meta.teamId = teamId

    if (eligible !== meta.eligible || channelChanged) {
      meta.eligible = eligible
      if (meta.managed && eligible)
        this.managedChannels.set(channelId, Date.now())
      if (meta.managed) {
        const autoslug = quill.getModule('autoslug')
        if (autoslug?.options)
          autoslug.options.includeAllBroadcastKeywords = eligible
        autocomplete.props.includeAllBroadcastKeywords = eligible
      }
    }

    let hasBroadcast = meta.hasBroadcast === true
    if (meta.eligible && (meta.dirty || channelChanged)) {
      meta.dirty = false
      try {
        hasBroadcast = deltaCandidateKinds(quill.getContents?.()).size > 0
      } catch {
        // noop
      }
      meta.hasBroadcast = hasBroadcast
    }
    const preflightKey =
      hasBroadcast && /^[TE][A-Z0-9]+$/.test(teamId)
        ? `${teamId}:${channelId}`
        : ''
    if (preflightKey && meta.preflightKey !== preflightKey) {
      meta.preflightKey = preflightKey
      void this.warmChannelReadiness(teamId, channelId, meta.store)
    } else if (!preflightKey && meta.preflightKey) {
      meta.preflightKey = ''
    }
  }

  private scheduleComposerUpgrade = () => {
    if (this.composerFrame || this.api.signal.aborted) return
    const schedule =
      window.requestAnimationFrame ||
      ((callback: () => void) => (window.setTimeout || setTimeout)(callback, 0))
    this.composerFrame = schedule(() => {
      this.composerFrame = 0
      if (this.api.signal.aborted) return
      for (const composer of Array.from(
        document.querySelectorAll?.(COMPOSER_SELECTOR) || []
      ))
        this.upgradeComposer(composer)
    })
  }

  private installComposerIntegration() {
    const upgradeFromEvent = (event: Event) => {
      const node = event.target as Node | null
      if (node?.nodeType !== 1) return
      const el = node as Element
      let composer = el.closest?.(COMPOSER_SELECTOR) || null
      if (!composer && el.matches?.(COMPOSER_SELECTOR)) composer = el
      if (composer) this.upgradeComposer(composer)
    }
    this.upgradeFromEvent = upgradeFromEvent
    for (const event of ['focusin', 'input', 'compositionend']) {
      document.addEventListener?.(event, upgradeFromEvent, true)
    }
    const root = document.documentElement || document.body
    if (typeof window.MutationObserver === 'function' && root) {
      // only composers live in these containers; skip the rest of slack's churn
      const containerSelector =
        '.p-message_pane_input, .p-message_input, .p-threads_footer, .ql-container, [data-qa="message_input"], [data-qa="texty_input"]'
      const affectsComposer = (records: MutationRecord[]): boolean => {
        for (const record of records) {
          const target = record.target as Element | null
          if (target && target.nodeType === 1) {
            try {
              if (target.closest?.(containerSelector)) return true
            } catch {
              // noop
            }
          }
          for (const node of Array.from(record.addedNodes)) {
            if (node && node.nodeType === 1) {
              try {
                const el = node as Element
                if (
                  el.matches?.(COMPOSER_SELECTOR) ||
                  el.querySelector?.(COMPOSER_SELECTOR)
                )
                  return true
              } catch {
                // noop
              }
            }
          }
        }
        return false
      }
      this.observer = new window.MutationObserver((records) => {
        if (affectsComposer(records)) this.scheduleComposerUpgrade()
      })
      this.observer.observe(root, {
        childList: true,
        subtree: true,
      })
    }
    this.scheduleComposerUpgrade()
  }

  private showError(detail: string, retry?: () => void) {
    const hint = retry
      ? 'Your message is still in Slack. You can try again, or use /bchannel directly.'
      : 'Slack may still be processing it. Check the conversation before sending it again.'
    const handle = this.api.modal.openModal({
      title: "This message wasn't sent",
      body: (
        <p style={{ whiteSpace: 'pre-wrap' }}>
          {detail}
          {'\n\n'}
          {hint}
        </p>
      ),
      submitText: retry ? 'Try again' : 'OK',
      cancelText: retry ? 'Cancel' : undefined,
      showCancelButton: !!retry,
      onSubmit: retry,
    })
    if (!handle)
      window.alert(`This message wasn't sent\n\n${detail}\n\n${hint}`)
  }

  private async stageIntent(intent: any): Promise<any> {
    const stagedResponse = await this.nativeFetch(
      `${this.serviceUrl()}/slick/intents`,
      {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(intent),
        signal: this.fetchSignal(15000),
      }
    )
    const staged = await stagedResponse.json().catch(() => ({}))
    if (
      !stagedResponse.ok ||
      typeof staged.commandText !== 'string' ||
      typeof staged.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(staged.token)
    ) {
      throw new Error(
        String(staged.message || "bChannel couldn't prepare this message.")
      )
    }
    return staged
  }

  private async ensureBChannelReady(
    staged: any,
    store: any,
    channelId: string
  ): Promise<boolean> {
    const botUserId = setupBotId(staged)
    if (
      !botUserId ||
      !store?.dispatch ||
      !store?.getState ||
      !isChannelConversation(channelId)
    )
      return false
    const cacheKey = `${botUserId}:${channelId}`
    const cachedAt = this.readyChannels.get(cacheKey) || 0
    if (Date.now() - cachedAt < READY_CHANNEL_TTL_MS) return false
    let runtimeRequire: any
    try {
      runtimeRequire = this.getSlackRequire()
    } catch {
      return false
    }

    let botIsMember = false
    let changedSlackState = false
    try {
      const membership = await runtimeRequire('eh+y').qY(
        store.dispatch,
        store.getState,
        channelId,
        [botUserId]
      )
      botIsMember = membership?.[botUserId] === true
      if (!botIsMember) {
        await store.dispatch(
          runtimeRequire('M9P0').Cw({
            channelId,
            users: botUserId,
            reason: 'taut-bchannel-private-channel-setup',
          })
        )
        changedSlackState = true
        for (let attempt = 1; attempt <= 10; attempt++) {
          if (this.api.signal.aborted) return changedSlackState
          await waitForSlack(slackPropagationDelay(attempt), this.api.signal)
          const refreshed = await runtimeRequire('eh+y').qY(
            store.dispatch,
            store.getState,
            channelId,
            [botUserId]
          )
          if (refreshed?.[botUserId] === true) {
            botIsMember = true
            break
          }
        }
      }
    } catch {}

    if (!botIsMember) return changedSlackState

    let postingReady = false
    try {
      const preferences = runtimeRequire('M9P0')
      const current = await store.dispatch(
        preferences.Kn({
          channelId,
          prefName: 'who_can_post',
          reason: 'taut-bchannel-check-posting-permissions',
        })
      )
      postingReady = prefAllowsBot(current, botUserId)
      if (!postingReady) {
        const whoCanPost = postingPrefWithBot(current, botUserId)
        if (whoCanPost) {
          await store.dispatch(
            runtimeRequire('Tid6').y({
              channelId,
              newPrefs: JSON.stringify({ who_can_post: whoCanPost }),
              reason: 'taut-bchannel-add-bot-posting-permission',
            })
          )
          changedSlackState = true
          for (let attempt = 1; attempt <= 10; attempt++) {
            if (this.api.signal.aborted) return changedSlackState
            await waitForSlack(slackPropagationDelay(attempt), this.api.signal)
            const refreshed = await store.dispatch(
              preferences.Kn({
                channelId,
                prefName: 'who_can_post',
                reason: 'taut-bchannel-confirm-posting-permissions',
              })
            )
            if (prefAllowsBot(refreshed, botUserId)) {
              postingReady = true
              break
            }
          }
        }
      }
    } catch {}
    if (changedSlackState) await waitForSlack(2_000, this.api.signal)
    if (botIsMember && postingReady)
      this.readyChannels.set(cacheKey, Date.now())
    return changedSlackState
  }

  private async discardIntent(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(token || ''))) return
    await this.nativeFetch(
      `${this.serviceUrl()}/slick/intents/${encodeURIComponent(token)}`,
      {
        method: 'DELETE',
        credentials: 'omit',
        signal: this.fetchSignal(5000),
      }
    ).catch(() => {})
  }

  private async handoff(candidate: any): Promise<boolean> {
    const recent = this.handled.get(candidate.dedupe)
    if (recent && Date.now() - recent < 2 * 60 * 1000) return true
    this.handled.set(candidate.dedupe, Date.now())
    for (const [key, at] of this.handled)
      if (Date.now() - at >= 2 * 60 * 1000) this.handled.delete(key)

    let stagedToken = ''
    let commandDispatched = false
    let ambiguousOutcome = false
    try {
      const sourceIds = (candidate.uploads || []).map(
        (upload: any) => upload.sourceId
      )
      const store = candidate.store || this.currentSlackStore()
      if (sourceIds.length && !store) {
        throw new Error(
          'Slack could not reopen the selected image. Keep this conversation open and try again.'
        )
      }
      const uploads = sourceIds.length
        ? await this.nativeUploads({ fileIds: sourceIds }, store)
        : []
      const intent = uploads.length
        ? {
            ...candidate.intent,
            files: uploads.map((upload: any) => upload.descriptor),
          }
        : candidate.intent
      let staged = await this.stageIntent(intent)
      stagedToken = staged.token
      if (
        await this.ensureBChannelReady(
          staged,
          this.currentSlackStore(),
          intent.channelId
        )
      ) {
        await this.discardIntent(staged.token)
        staged = await this.stageIntent(intent)
        stagedToken = staged.token
      }

      const commandBody = new URLSearchParams({
        token: candidate.token,
        channel: intent.channelId,
        command: '/bchannel',
        text: staged.commandText,
      })
      let commandResponse: Response
      try {
        commandResponse = await this.nativeFetch('/api/chat.command', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          },
          body: commandBody,
          signal: this.fetchSignal(15000),
        })
      } catch (error) {
        ambiguousOutcome = true
        throw new Error(
          "Slack didn't confirm whether bChannel received this message.",
          { cause: error }
        )
      }
      const commandResult = await commandResponse.json().catch(() => ({}))
      if (!commandResponse.ok || commandResult.ok === false) {
        const code = String(
          commandResult.error || `http_${commandResponse.status}`
        )
        const messages: Record<string, string> = {
          dispatch_failed:
            "Slack couldn't reach bChannel. Check that the bChannel app is installed and available.",
          unknown_command:
            "The /bchannel command isn't installed in this workspace. Ask an admin to install bChannel.",
          command_not_found:
            "The /bchannel command isn't installed in this workspace. Ask an admin to install bChannel.",
          invalid_auth:
            'Your Slack session is out of date. Sign in to Slack again, then retry.',
          not_authed:
            'Slack needs you to sign in again before bChannel can send this message.',
          account_inactive:
            'Your Slack account is inactive, so this message could not be sent.',
          team_access_not_granted:
            "bChannel isn't installed for this workspace. Ask an admin to install it.",
          ratelimited:
            'Slack is receiving too many commands right now. Wait a moment and retry.',
        }
        throw new Error(
          messages[code] ||
            `Slack couldn't hand this message to bChannel (${code}).`
        )
      }
      commandDispatched = true

      try {
        await this.uploadStagedFiles(staged.token, uploads)
      } catch (error) {
        ambiguousOutcome = true
        throw error
      }
      return true
    } catch (error) {
      if (stagedToken && !commandDispatched) {
        await this.discardIntent(stagedToken)
      }
      this.handled.delete(candidate.dedupe)
      const message =
        error instanceof Error
          ? error.message
          : 'bChannel is unavailable right now.'
      this.showError(
        message,
        ambiguousOutcome ? undefined : () => this.handoff(candidate)
      )
      return false
    }
  }

  private async handoffAsSlackResponse(candidate: any): Promise<Response> {
    const sent = await this.handoff(candidate)
    return new Response(
      JSON.stringify(
        sent
          ? { ok: true, channel: candidate.intent.channelId }
          : { ok: false, error: 'restricted_action' }
      ),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  private async handoffDelete(
    candidate: any
  ): Promise<{ ok: boolean; fallThrough: boolean }> {
    if (!candidate.token) return { ok: false, fallThrough: true }
    let staged: any
    try {
      staged = await this.stageIntent({
        version: 1,
        action: 'delete',
        channelId: candidate.channelId,
        ts: candidate.ts,
        ...(candidate.teamId ? { teamId: candidate.teamId } : {}),
      })
    } catch {
      return { ok: false, fallThrough: true }
    }
    const commandBody = new URLSearchParams({
      token: candidate.token,
      channel: candidate.channelId,
      command: '/bchannel',
      text: staged.commandText,
    })
    let commandResponse: Response
    try {
      commandResponse = await this.nativeFetch('/api/chat.command', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: commandBody,
        signal: this.fetchSignal(15000),
      })
    } catch {
      return { ok: false, fallThrough: false }
    }
    const result = await commandResponse.json().catch(() => ({}))
    if (!commandResponse.ok || result.ok === false) {
      const code = String(result.error || `http_${commandResponse.status}`)
      if (code === 'unknown_command' || code === 'command_not_found') {
        this.showError(
          "The /bchannel command isn't installed in this workspace. Ask an admin to install bChannel."
        )
        return { ok: false, fallThrough: false }
      }
      this.showError(
        String(
          result.message ||
            "bChannel couldn't delete this message. Try deleting it as the bot directly."
        )
      )
      return { ok: false, fallThrough: false }
    }
    return { ok: true, fallThrough: false }
  }

  private maybeHandoff(candidate: any, result: any) {
    if (
      !candidate ||
      !result ||
      result.ok !== false ||
      !DENIED_BROADCASTS.has(result.error)
    )
      return
    void this.handoff(candidate)
  }

  start(): void {
    this.nativeFetch = window.fetch.bind(window)
    this.originalFetch = window.fetch
    // @ts-expect-error assign a plain function to window.fetch
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      let kind = 0
      if (init) {
        const url = requestUrl(input)
        if (url.indexOf('/api/chat.postMessage') !== -1) kind = 1
        else if (url.indexOf('/api/files.completeUploadExternal') !== -1)
          kind = 2
        else if (url.indexOf('/api/chat.delete') !== -1) kind = 3
      }
      if (!kind) return this.nativeFetch(input, init)
      const body = init?.body
      let candidate = null
      if (kind === 1) candidate = candidateFromBody(body)
      else if (kind === 2) candidate = candidateFromFileCompletion(body)
      else candidate = candidateFromDelete(body)
      if (candidate && kind === 3) {
        if (!this.isBChannelMessage(candidate.channelId, candidate.ts))
          return this.nativeFetch(input, init)
        return this.handoffDelete(candidate).then(({ ok, fallThrough }) =>
          fallThrough
            ? this.nativeFetch(input, init)
            : new Response(
                JSON.stringify(
                  ok
                    ? {
                        ok: true,
                        channel: candidate.channelId,
                        ts: candidate.ts,
                      }
                    : { ok: false, error: 'cannot_delete_message' }
                ),
                { status: 200, headers: { 'content-type': 'application/json' } }
              )
        )
      }
      if (
        candidate &&
        (candidate.requiresHandoff ||
          this.isManagedChannel(candidate.intent.channelId))
      ) {
        return this.handoffAsSlackResponse(candidate)
      }
      const request = this.nativeFetch(input, init)
      if (candidate) {
        request
          .then((response) => {
            response
              .clone()
              .json()
              .then((result) => this.maybeHandoff(candidate, result))
              .catch(() => {})
          })
          .catch(() => {})
      }
      return request
    }

    this.originalXHROpen = XMLHttpRequest.prototype.open
    const originalOpen = this.originalXHROpen
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: Array<boolean | string | null>
    ) {
      const u = String(url)
      if (String(method || 'GET').toUpperCase() !== 'POST') {
        ;(this as any).__tautBChannelPost = false
        return originalOpen.call(
          this,
          method,
          url,
          ...(rest as [boolean, ...Array<string | null>])
        )
      }
      ;(this as any).__tautBChannelUrl = u
      ;(this as any).__tautBChannelPost =
        u.indexOf('/api/chat.postMessage') !== -1 ||
        u.indexOf('/api/files.completeUploadExternal') !== -1 ||
        u.indexOf('/api/chat.delete') !== -1
      return originalOpen.call(
        this,
        method,
        url,
        ...(rest as [boolean, ...Array<string | null>])
      )
    } as typeof XMLHttpRequest.prototype.open

    this.originalXHRSend = XMLHttpRequest.prototype.send
    const originalSend = this.originalXHRSend
    const maybeHandoff = this.maybeHandoff.bind(this)
    const handoffDelete = this.handoffDelete.bind(this)
    const isBChannelMessage = this.isBChannelMessage.bind(this)
    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null
    ) {
      const url = (this as any).__tautBChannelUrl || ''
      if (url.indexOf('/api/chat.delete') !== -1) {
        const candidate = candidateFromDelete(body)
        if (candidate && isBChannelMessage(candidate.channelId, candidate.ts)) {
          void handoffDelete(candidate).then(({ ok, fallThrough }) => {
            if (fallThrough) {
              originalSend.call(this, body)
              return
            }
            const payload = JSON.stringify(
              ok
                ? { ok: true, channel: candidate.channelId, ts: candidate.ts }
                : { ok: false, error: 'cannot_delete_message' }
            )
            for (const [key, value] of Object.entries({
              readyState: 4,
              status: 200,
              statusText: 'OK',
              responseText: payload,
              response: payload,
            })) {
              Object.defineProperty(this, key, {
                configurable: true,
                writable: true,
                value,
              })
            }
            for (const type of ['readystatechange', 'load', 'loadend']) {
              this.dispatchEvent(new Event(type))
            }
          })
          return
        }
      }
      if (
        (this as any).__tautBChannelPost &&
        url.indexOf('/api/chat.delete') === -1
      ) {
        const candidate =
          url.indexOf('/api/files.completeUploadExternal') !== -1
            ? candidateFromFileCompletion(body)
            : candidateFromBody(body)
        if (candidate) {
          this.addEventListener(
            'load',
            () =>
              maybeHandoff(
                candidate,
                responseData(this.responseText || this.response)
              ),
            { once: true }
          )
        }
      }
      return originalSend.call(this, body)
    }

    this.installComposerIntegration()

    this.api.patchComponent<{
      channelId?: string
      teamId?: string
      prepareAndSendMessage: (args: any) => Promise<unknown>
    }>('MessagePaneInput', (Original) => (props) => {
      const send = React.useCallback(
        (args: any) => {
          const channelId = String(props.channelId || '')
          const meta = {
            managed: this.isManagedChannel(channelId),
            eligible: isChannelConversation(channelId),
            store: this.currentSlackStore(),
            composer: document,
            teamId: String(props.teamId || ''),
          }
          return this.prepareNativeHandoff(
            props.prepareAndSendMessage,
            args,
            meta
          ).catch((error) => {
            this.showError(
              error instanceof Error
                ? error.message
                : 'bChannel is unavailable right now.'
            )
            throw error
          })
        },
        [props.prepareAndSendMessage, props.channelId, props.teamId]
      )
      return <Original {...props} prepareAndSendMessage={send} />
    })

    this.log('Started')

    this.evictionTimer = window.setInterval(() => {
      const now = Date.now()
      for (const [key, at] of this.readyChannels)
        if (now - at >= READY_CHANNEL_TTL_MS) this.readyChannels.delete(key)
      for (const [key, entry] of this.setupCache)
        if (now >= entry.expiresAt) this.setupCache.delete(key)
      for (const [key, at] of this.managedChannels)
        if (now - at >= MANAGED_CHANNEL_TTL_MS) this.managedChannels.delete(key)
    }, 5 * 60_000)
  }

  stop(): void {
    if (this.evictionTimer) window.clearInterval(this.evictionTimer)
    this.evictionTimer = null
    if (this.originalFetch) window.fetch = this.originalFetch
    if (this.originalXHROpen)
      XMLHttpRequest.prototype.open = this.originalXHROpen
    if (this.originalXHRSend)
      XMLHttpRequest.prototype.send = this.originalXHRSend
    this.originalFetch = null
    this.originalXHROpen = null
    this.originalXHRSend = null

    for (const event of ['focusin', 'input', 'compositionend']) {
      if (this.upgradeFromEvent)
        document.removeEventListener(event, this.upgradeFromEvent, true)
    }
    this.upgradeFromEvent = null
    this.observer?.disconnect()
    this.observer = null
    if (this.composerFrame) {
      cancelAnimationFrame(this.composerFrame)
      this.composerFrame = 0
    }

    this.handled.clear()
    this.handoffsInFlight.clear()
    this.readyChannels.clear()
    this.setupCache.clear()
    this.readinessChecksInFlight.clear()
    this.managedChannels.clear()
    this.slackRequire = null
    this.slackSerializer = null
  }
}
