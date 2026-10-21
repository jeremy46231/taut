// Warns before you send a haiku that Orpheus would repeat in the thread

import { opt, TautPlugin } from '$taut'

const DICTIONARY_COMMIT = 'aece7f5fcc873b8e71ecccfa5216849fafd959e1'
const DICTIONARY_URL = `https://raw.githubusercontent.com/hackclub/orpheus-bot/${DICTIONARY_COMMIT}/app/lib/haiku_check/syllable_counts.txt`
const DOWNLOAD_TIMEOUT = 60_000
/** how long after a failed download to try it again */
const RETRY_AFTER = 10 * 60_000
const ORPHEUS_USER = 'UM1L1C38X'
/** where Orpheus skips haikus, or firehose deletes her replies */
const SKIPPED_CHANNELS = [
  'C09MATKQM8C', // flavortown-help
  'CNMU9L92Q', // confessions
  'C0188CY57PZ', // meta
  'C07TM4C0AQ5', // help
  'C0B3NSM2CMP', // phantom-bulletin
  'C085UEFDW6R', // community-logs
  'C0AP0NMSP3P', // stardance-help
  'CN523HLKW', // hcb
  'C0ANGHXK0KH', // prometheus-public
]

type ContextBarProps = {
  channelId?: string
  draftId?: string
  onIsContextBarShowing?: (showing: boolean) => void
}

export default class HaikuWarning extends TautPlugin<typeof HaikuWarning> {
  static readonly id = 'HaikuWarning'
  static readonly pluginName = 'Haiku Warning'
  static readonly description =
    'Warns before you send a haiku that Orpheus would repeat in the thread'
  static readonly authors = ['izie', 'jeremy'] as const
  static readonly category = 'messageBox'
  static readonly hackClubOnly = true
  static readonly defaultConfig = {
    enabled: false,
    holdSend: opt(
      false,
      'Hold the first send of a haiku, send again to send anyway'
    ),
    popup: opt(
      false,
      'Use a pop-up when you send, instead of a live banner as you type'
    ),
    anyChannel: opt(
      false,
      "Also warn where Orpheus isn't, like DMs and private channels without her"
    ),
  }

  // keyed by commit, so bumping it replaces the old copy
  private cache = new this.api.Cache<string>('syllables', { maxSize: 1 })
  private readonly dictionary = new this.api.Store<string | undefined>(
    undefined
  )
  private loading = false
  private retryAt = 0
  /** conversations whose Orpheus membership has been checked */
  private readonly lookedUp = new Set<string>()

  /** the haiku the last send was held for, typing forgets it */
  private held: string | null = null

  start(): void {
    this.loadDictionary()

    if (this.config.popup || this.config.holdSend) this.startSendCheck()
    if (this.config.popup) return

    // when multiple bars, combine them
    this.api.setStyle(`
      .p-context_bar_v2:has(+ .taut-haiku-context-bar) > .p-context_bar_v2__filler {
        display: none;
      }
      .p-context_bar_v2 + .taut-haiku-context-bar {
        border-top-left-radius: 0;
        border-top-right-radius: 0;
      }
    `)

    this.api.patchComponent<ContextBarProps>(
      'BaseContextBarV2',
      (Original) => (props) => {
        const shown = this.useHaiku(props)
        const { onIsContextBarShowing } = props
        const onShowing = React.useCallback(
          (showing: boolean) => onIsContextBarShowing?.(showing || shown),
          [onIsContextBarShowing, shown]
        )
        return (
          <>
            <Original {...props} onIsContextBarShowing={onShowing} />
            {shown && (
              <div
                className="p-context_bar_v2 p-context_bar_v2--yellow taut-haiku-context-bar"
                data-qa="context_bar"
                data-context-bar
              >
                <div className="p-context_bar_v2__icon">
                  <this.api.elements.SvgIcon name="warning" />
                </div>
                <div className="p-context_bar_v2__content">
                  Orpheus may repeat this haiku in the thread
                </div>
                <div className="p-context_bar_v2__filler" />
              </div>
            )}
          </>
        )
      }
    )
  }

  /** holds a send for a haiku, with a pop-up or by sending again */
  private startSendCheck(): void {
    this.api.redux.patchThunk(
      'currentUserStartedTyping',
      (original) =>
        (...args: unknown[]) => {
          this.held = null
          return original(...args)
        }
    )
    this.api.composer.addSendCheck(async (blocks, { channelId, threadTs }) => {
      const dictionary = this.dictionary.get()
      if (SKIPPED_CHANNELS.includes(channelId)) return true
      if (!dictionary) {
        this.loadDictionary()
        return true
      }
      try {
        if (!this.config.anyChannel && !this.orpheusIn(channelId)) return true
        const text = blocksToSlackText(blocks)
        // Orpheus skips messages this long, counted in code points like Ruby
        if ([...text].length >= 300) return true
        const haiku = findHaiku(text, (word) =>
          dictionaryLookup(dictionary, word)
        )
        if (!haiku) return true

        if (this.config.popup) return await this.confirmPopup(haiku)

        const key = `${channelId}\n${threadTs ?? ''}\n${haiku.join('\n')}`
        if (this.held === key) {
          this.held = null
          return true
        }
        this.held = key
        return false
      } catch (error) {
        this.log('Could not check message', error)
        return true
      }
    })
  }

  private confirmPopup(haiku: string[]): Promise<boolean> {
    return this.api.modal.confirm({
      title: (
        <this.api.elements.MrkdwnElement text=":orpheus-woah: Found a haiku in your message!" />
      ),
      confirmText: 'Send anyway',
      cancelText: 'Keep editing',
      body: (
        <>
          <p style={{ marginTop: 0 }}>
            If Orpheus is in this channel, she'll repeat it in the thread, where
            you can't delete it.
          </p>
          <blockquote style={{ whiteSpace: 'pre-line' }}>
            {haiku.join('\n')}
          </blockquote>
          <p style={{ marginBottom: 0 }}>
            <code>/disable-haiku</code> stops Orpheus from repeating your
            haikus.
          </p>
        </>
      ),
    })
  }

  /** whether Orpheus would reply in a conversation, as far as Slack knows */
  private orpheusIn(channelId: string): boolean {
    const state = this.api.redux.getRawState()
    const channel = state?.channels?.[channelId]
    if (channel?.is_channel && !channel.is_private) return true
    const known = state?.membership?.[channelId]?.[ORPHEUS_USER]
    return !!known?.isKnown && !!known.isMember
  }

  /** whether a composer's draft is a haiku Orpheus would find, as it's typed */
  private useHaiku({ channelId, draftId }: ContextBarProps) {
    const present = this.useOrpheusIn(channelId)
    const checked =
      !!channelId &&
      !SKIPPED_CHANNELS.includes(channelId) &&
      (this.config.anyChannel || !!present)
    const dictionary = this.dictionary.use()
    const ops = this.api.redux.useReduxState((state): unknown[] | undefined =>
      draftId ? state?.drafts?.unifiedDrafts?.[draftId]?.ops : undefined
    )
    const [found, setFound] = React.useState(false)
    React.useEffect(() => {
      if (!checked || !ops) {
        setFound(false)
        return
      }
      if (!dictionary) {
        this.loadDictionary()
        return
      }
      let current = true
      this.api.blocks
        .fromDraft(ops)
        .then((blocks) => {
          if (!current) return
          const text = blocksToSlackText(blocks)
          // Orpheus skips messages this long, counted in code points like Ruby
          setFound(
            [...text].length < 300 &&
              !!findHaiku(text, (word) => dictionaryLookup(dictionary, word))
          )
        })
        .catch((error) => this.log('Could not check draft', error))
      return () => {
        current = false
      }
    }, [checked, ops, dictionary])
    return checked && !!ops && found
  }

  /** whether Orpheus would reply in a conversation, undefined until Slack knows if she's in it */
  private useOrpheusIn(channelId: string | undefined): boolean | undefined {
    const present = this.api.redux.useReduxState(
      (state): boolean | undefined => {
        if (!channelId) return false
        const channel = state?.channels?.[channelId]
        // she joins public channels to reply, and can't join private ones
        if (channel?.is_channel && !channel.is_private) return true
        const known = state?.membership?.[channelId]?.[ORPHEUS_USER]
        return known?.isKnown ? !!known.isMember : undefined
      }
    )
    React.useEffect(() => {
      if (present !== undefined || !channelId || this.lookedUp.has(channelId))
        return
      this.lookedUp.add(channelId)
      const lookup = this.api.redux
        .dispatchThunk('getChannelMembershipInfoForUsers', {
          channelId,
          userIds: [ORPHEUS_USER],
        })
        .catch((error) => this.log('Could not look up Orpheus', error))
      this.api.within(lookup, 5_000, "Slack's membership lookup")
    }, [present, channelId])
    return present
  }

  private async loadDictionary() {
    if (this.loading || Date.now() < this.retryAt) return
    this.loading = true
    try {
      await this.cache.load()
      const dictionary = await this.cache.fetch(DICTIONARY_COMMIT, async () => {
        const response = await this.api.fetch(DICTIONARY_URL, {
          signal: AbortSignal.any([
            this.api.signal,
            AbortSignal.timeout(DOWNLOAD_TIMEOUT),
          ]),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const dictionary = await response.text()
        if (dictionary.length < 1_000_000) {
          throw new Error('Incomplete dictionary')
        }
        return dictionary
      })
      this.dictionary.set(dictionary)
    } catch (error) {
      if (this.api.signal.aborted) return
      this.log('Could not load dictionary', error)
      this.retryAt = Date.now() + RETRY_AFTER
    } finally {
      this.loading = false
    }
  }
}

// port of Orpheus's haiku check (hackclub/orpheus-bot app/lib/haiku_check)

type SyllableLookup = (word: string) => number | undefined

const words = (text: string) => text.trim().split(/\s+/)

const SUB_SYLLABLES = words(`
  cial tia cius cious uiet gious geous priest giu dge ion iou sia$ .che$ .ched$
  .abe$ .ace$ .ade$ .age$ .aged$ .ake$ .ale$ .aled$ .ales$ .ane$ .ame$ .ape$
  .are$ .ase$ .ashed$ .asque$ .ate$ .ave$ .azed$ .awe$ .aze$ .aped$ .athe$
  .athes$ .ece$ .ese$ .esque$ .esques$ .eze$ .gue$ .ibe$ .ice$ .ide$ .ife$ .ike$
  .ile$ .ime$ .ine$ .ipe$ .iped$ .ire$ .ise$ .ished$ .ite$ .ive$ .ize$ .obe$
  .ode$ .oke$ .ole$ .ome$ .one$ .ope$ .oque$ .ore$ .ose$ .osque$ .osques$ .ote$
  .ove$ .pped$ .sse$ .ssed$ .ste$ .ube$ .uce$ .ude$ .uge$ .uke$ .ule$ .ules$
  .uled$ .ume$ .une$ .upe$ .ure$ .use$ .ushed$ .ute$ .ved$ .we$ .wes$ .wed$
  .yse$ .yze$ .rse$ .red$ .rce$ .rde$ .ily$ .ely$ .des$ .gged$ .kes$ .ced$ .ked$
  .med$ .mes$ .ned$ .[sz]ed$ .nce$ .rles$ .nes$ .pes$ .tes$ .res$ .ves$ ere$
`).map((pattern) => new RegExp(pattern))

const ADD_SYLLABLES = words(`
  ia riet dien ien iet iu iest io ii ily .oala$ .iara$ .ying$ .earest .arer
  .aress .eate$ .eation$ [aeiouym]bl$ [aeiou]{3} ^mc ism ^mc asm ([^aeiouy])1l$
  [^l]lien ^coa[dglx]. [^gq]ua[^auieo] dnt$
`).map((pattern) => new RegExp(pattern))

const SMALL = words(`
  zero one two three four five six seven eight nine ten eleven twelve thirteen
  fourteen fifteen sixteen seventeen eighteen nineteen
`)

const TENS = [
  '',
  '',
  ...words(`
    twenty thirty forty fifty sixty seventy eighty ninety
  `),
]

const LOTS = [
  '',
  ...words(`
    thousand million billion trillion quadrillion quintillion sextillion
    septillion octillion nonillion decillion undecillion duodecillion tredecillion
    quattuordecillion quindecillion sexdecillion septendecillion octodecillion
    novemdecillion vigintillion unvigintillion duovigintillion trevigintillion
    quattuortillion quinvigintillion sexvigintillion septenvigintillion
    octovigintillion novemvigintillion trigintillion untrigintillion
    duotrigintillion trestrigintillion quattuortrigintillion quintrigintillion
    sextrigintillion septentrigintillion octotrigintillion novemtrigintillion
    quadragintillion unquadragintillion duoquadragintillion trequadragintillion
    quattuorquadragintillion quinquadragintillion sesquadragintillion
    septenquadragintillion octoquadragintillion novenquadragintillion
    quinquagintillion
  `),
]

function underThousand(value: number): string {
  if (value < 20) return SMALL[value]
  if (value < 100) {
    const remainder = value % 10
    return `${TENS[Math.floor(value / 10)]}${remainder ? `-${SMALL[remainder]}` : ''}`
  }
  const remainder = value % 100
  return `${SMALL[Math.floor(value / 100)]} hundred${remainder ? ` and ${underThousand(remainder)}` : ''}`
}

/** matches Integer#humanize from humanize 3.1.0, which Orpheus uses */
function humanizeInteger(digits: string): string {
  let value = BigInt(digits)
  if (value === 0n) return 'zero'

  let iteration = 0
  let useAnd = false
  const parts: string[] = []
  while (value !== 0n) {
    const remainder = Number(value % 1000n)
    value /= 1000n
    if (remainder !== 0) {
      if (iteration === 0 && remainder < 100) useAnd = true
      else if (LOTS[iteration]) {
        parts.push(
          `${LOTS[iteration]}${parts.length ? (useAnd ? ' and' : ',') : ''}`
        )
      }
      parts.push(underThousand(remainder))
    }
    iteration++
  }
  return parts.reverse().join(' ')
}

function estimateSyllables(word: string): number {
  if (!word) return 0
  word = word.toLowerCase()
  let syllables = word.split(/[^aeiouy]+/).filter(Boolean).length
  for (const pattern of SUB_SYLLABLES) {
    if (pattern.test(word)) syllables--
  }
  for (const pattern of ADD_SYLLABLES) {
    if (pattern.test(word)) syllables++
  }
  return Math.max(1, syllables)
}

function findHaiku(
  input: string,
  lookup: SyllableLookup
): [string, string, string] | null {
  // ruby's `\s` is ascii-only, js's also matches unicode spaces
  let text = input.toLowerCase().replace(/[^a-zA-Z0-9 \t\n\v\f\r.$]/g, '')
  text = text.replace(/\$/g, 'dollar ').replace(/\bise\b/g, 'ize')
  text = text.replace(/\d+/g, humanizeInteger)

  const lines: string[][] = [[], [], []]
  const targets = [5, 7, 5]
  let line = 0
  let count = 0
  for (const word of text.split(/[ \t\n\v\f\r]+/).filter(Boolean)) {
    const syllables = lookup(word) ?? estimateSyllables(word)
    if (line > 2 || count + syllables > targets[line]) return null
    lines[line].push(word)
    count += syllables
    if (count === targets[line]) {
      line++
      count = 0
    }
  }

  return line === 3
    ? [lines[0].join(' '), lines[1].join(' '), lines[2].join(' ')]
    : null
}

/** binary search to skip building a 134k-entry Map, needs the dictionary sorted */
function dictionaryLookup(
  dictionary: string,
  word: string
): number | undefined {
  let low = 0
  let high = dictionary.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const lineStart =
      middle === 0 ? 0 : dictionary.lastIndexOf('\n', middle - 1) + 1
    let lineEnd = dictionary.indexOf('\n', lineStart)
    if (lineEnd === -1) lineEnd = dictionary.length
    const separator = dictionary.lastIndexOf(' ', lineEnd - 1)
    const candidate = dictionary.slice(lineStart, separator)
    if (candidate === word)
      return Number(dictionary.slice(separator + 1, lineEnd))
    if (candidate < word) low = lineEnd + 1
    else high = lineStart
  }
  return undefined
}

type RichTextNode = {
  type?: string
  text?: string
  url?: string
  user_id?: string
  channel_id?: string
  file_id?: string
  usergroup_id?: string
  name?: string
  skin_tone?: number
  range?: string
  timestamp?: number
  format?: string
  fallback?: string
  style?:
    | string
    | {
        bold?: boolean
        italic?: boolean
        strike?: boolean
        code?: boolean
      }
  indent?: number
  offset?: number
  elements?: RichTextNode[]
}

/** Slack escapes these */
const escapeText = (text: string) =>
  text
    .replace(/&(?!amp|lt|gt)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/** in order from outermost to innermost, for styles that start and end together */
const MARKERS = { strike: '~', italic: '_', bold: '*', code: '`' } as const
type Marker = keyof typeof MARKERS

function markersOf(node: RichTextNode): Marker[] {
  // Slack never styles emoji or text that's only whitespace
  if (node.type === 'emoji' || (node.type === 'text' && !node.text?.trim()))
    return []
  const style = typeof node.style === 'object' ? node.style : {}
  return (Object.keys(MARKERS) as Marker[]).filter((marker) => style[marker])
}

/** each style opens and closes on its own, so markers can overlap like `*a_b*c_` */
function inlineText(nodes: RichTextNode[]): string {
  const markers = nodes.map(markersOf)
  const runLength = (start: number, marker: Marker) => {
    let end = start
    while (markers[end]?.includes(marker)) end++
    return end - start
  }
  const write = (list: Marker[]) =>
    list.map((marker) => MARKERS[marker]).join('')
  const open: Marker[] = []
  let result = ''
  const close = (keep: Marker[]) => {
    const closing = open.filter((marker) => !keep.includes(marker)).reverse()
    for (const marker of closing) open.splice(open.indexOf(marker), 1)
    // closing markers go before trailing whitespace
    result = result.replace(/\s*$/, (tail) => `${write(closing)}${tail}`)
  }
  nodes.forEach((node, i) => {
    close(markers[i])
    const opening = markers[i]
      .filter((marker) => !open.includes(marker))
      .sort((a, b) => runLength(i, b) - runLength(i, a))
    open.push(...opening)
    // opening markers go after leading whitespace
    result += nodeText(node).replace(
      /^\s*/,
      (lead) => `${lead}${write(opening)}`
    )
  })
  close([])
  return result
}

/** joins blocks without doubling or dropping the newlines between them */
function joinSections(sections: string[]): string {
  return sections.reduce((text, next) => {
    const separator =
      text && next && !text.endsWith('\n') && !next.startsWith('\n') ? '\n' : ''
    return text + separator + next
  }, '')
}

function romanNumeral(n: number): string {
  const numerals = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ] as const
  let result = ''
  for (const [value, numeral] of numerals)
    while (n >= value) {
      result += numeral
      n -= value
    }
  return result
}

/** Slack writes the letter as the byte `(96 + n) % 256` and decodes it alone as UTF-8 */
function listLetter(n: number): string {
  const byte = (96 + n) % 256
  const bad = (bits: number) => `BAD+${bits.toString(16).toUpperCase()}`
  if (byte >= 0x80 && byte <= 0xbf) return bad(byte)
  if (byte >= 0xc2 && byte <= 0xdf) return bad(byte & 0x1f)
  if (byte >= 0xe0 && byte <= 0xef) return bad(byte & 0x0f)
  if (byte >= 0xf0 && byte <= 0xf4) return bad(byte & 0x07)
  if (byte === 0x0d) return '\n'
  if (byte >= 0x7f || (byte < 0x20 && (byte < 0x09 || byte > 0x0c))) return ''
  return escapeText(String.fromCharCode(byte))
}

/** nested lists cycle through three marker styles */
function listMarker(list: RichTextNode, i: number): string {
  const depth = (list.indent ?? 0) % 3
  if (list.style !== 'ordered') return ['•', '◦', '▪︎'][depth]
  const n = (list.offset ?? 0) + i + 1
  if (depth === 0) return `${n}.`
  if (depth === 1) return `${listLetter(n)}.`
  return `${romanNumeral(n)}.`
}

function listText(list: RichTextNode): string {
  const indent = '    '.repeat(list.indent ?? 0)
  return (list.elements ?? [])
    .map((item, i) => `${indent}${listMarker(list, i)} ${nodeText(item)}`)
    .join('\n')
}

function nodeText(node: RichTextNode): string {
  switch (node.type) {
    case 'text':
      return escapeText(node.text ?? '')
    case 'user':
      return `<@${node.user_id}>`
    case 'channel':
      return `<#${node.channel_id}>`
    case 'usergroup':
      return `<!subteam^${node.usergroup_id}>`
    case 'broadcast':
      return `<!${node.range}>`
    case 'emoji':
      return `:${node.name}:${node.skin_tone ? `:skin-tone-${node.skin_tone}:` : ''}`
    case 'date':
      return escapeText(
        `<!date^${node.timestamp}^${node.format}|${node.fallback ?? ''}>`
      )
    case 'rich_text':
    case 'expanded_rich_text':
      return joinSections((node.elements ?? []).map(nodeText))
    case 'rich_text_list':
      return listText(node)
    case 'rich_text_quote':
      return inlineText(node.elements ?? [])
        .split('\n')
        .map((line) => `&gt; ${line}`)
        .join('\n')
    case 'rich_text_preformatted':
      return `\`\`\`${inlineText(node.elements ?? [])}\`\`\``
  }
  // pasted file and canvas links are sent as the file's id
  if (node.file_id) return node.file_id
  // links, and permalinks Slack turned into message mentions
  if (node.url) {
    const url = escapeText(node.url)
    return node.text ? `<${url}|${escapeText(node.text)}>` : `<${url}>`
  }
  return inlineText(node.elements ?? [])
}

/** recreates the mrkdwn text Slack delivers with a message event */
function blocksToSlackText(blocks: unknown[]): string {
  return (blocks as RichTextNode[]).map(nodeText).join(' ')
}
