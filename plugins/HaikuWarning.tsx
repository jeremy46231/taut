// Warns before you send a haiku that Orpheus would repeat in the thread

import { TautPlugin } from '$taut'

const DICTIONARY_COMMIT = 'aece7f5fcc873b8e71ecccfa5216849fafd959e1'
const DICTIONARY_URL = `https://raw.githubusercontent.com/hackclub/orpheus-bot/${DICTIONARY_COMMIT}/app/lib/haiku_check/syllable_counts.txt`
const DOWNLOAD_TIMEOUT = 60_000
/** how long after a failed download a send may try it again */
const RETRY_AFTER = 10 * 60_000

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
  }

  // keyed by commit, so bumping it replaces the old copy
  private cache = new this.api.Cache<string>('syllables', { maxSize: 1 })
  private dictionary?: string
  private loading = false
  private retryAt = 0

  start(): void {
    this.loadDictionary()
    this.api.composer.addSendCheck(async (blocks, { channelId }) => {
      const skippedChannels = [
        'CNMU9L92Q', // meta
        'C09MATKQM8C', // flavortown
      ]
      if (skippedChannels.includes(channelId)) return true
      const { dictionary } = this
      // best effort, so a send never waits on the download
      if (!dictionary) {
        this.loadDictionary()
        return true
      }
      try {
        const text = blocksToSlackText(blocks)
        // Orpheus skips messages this long, counted in code points like Ruby
        if ([...text].length >= 300) return true
        const haiku = findHaiku(text, (word) =>
          dictionaryLookup(dictionary, word)
        )
        if (!haiku) return true

        return await this.api.modal.confirm({
          title: (
            <this.api.elements.MrkdwnElement text=":orpheus-woah: Found a haiku in your message!" />
          ),
          confirmText: 'Send anyway',
          cancelText: 'Keep editing',
          body: (
            <>
              <p style={{ marginTop: 0 }}>
                If Orpheus is in this channel, she'll repeat it in the thread,
                where you can't delete it.
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
      } catch (error) {
        this.log('Could not check message', error)
        return true
      }
    })
  }

  private async loadDictionary() {
    if (this.loading || Date.now() < this.retryAt) return
    this.loading = true
    try {
      await this.cache.load()
      this.dictionary = await this.cache.fetch(DICTIONARY_COMMIT, async () => {
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
  style?: string | Record<string, unknown>
  indent?: number
  offset?: number
  elements?: RichTextNode[]
}

/** Slack escapes these three in message text */
const escapeText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function listText(list: RichTextNode): string {
  const indent = '    '.repeat(list.indent ?? 0)
  return (list.elements ?? [])
    .map((item, i) => {
      const marker =
        list.style === 'ordered' ? `${(list.offset ?? 0) + i + 1}.` : '•'
      return `${indent}${marker} ${nodeText(item)}`
    })
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
      return `<!date^${node.timestamp}^${node.format}|${escapeText(node.fallback ?? '')}>`
    case 'rich_text_list':
      return listText(node)
    case 'rich_text_quote':
      return nodeText({ elements: node.elements })
        .split('\n')
        .map((line) => `&gt; ${line}`)
        .join('\n')
    case 'rich_text_preformatted':
      return `\`\`\`${nodeText({ elements: node.elements })}\`\`\``
  }
  // pasted file and canvas links are sent as the file's id
  if (node.file_id) return node.file_id
  // links, and permalinks Slack turned into message mentions
  if (node.url) {
    const url = escapeText(node.url)
    return node.text ? `<${url}|${escapeText(node.text)}>` : `<${url}>`
  }
  const children = node.elements ?? []
  if (node.type !== 'rich_text') return children.map(nodeText).join('')
  // a section runs on into the next, the other blocks end their line
  return children
    .map((child, i) => {
      const next = children[i + 1]
      const ownLine =
        next &&
        (child.type !== 'rich_text_section' ||
          next.type !== 'rich_text_section')
      return ownLine ? `${nodeText(child)}\n` : nodeText(child)
    })
    .join('')
}

/** recreates the mrkdwn text Slack delivers with a message event */
function blocksToSlackText(blocks: unknown[]): string {
  return (blocks as RichTextNode[]).map(nodeText).join('\n')
}
