// Masks words you choose in messages, only on your screen

import { opt, TautPlugin } from '$taut'

const WORD_CHAR = /[\p{L}\p{N}_]/u

/** one alternative per term, whole words only, any whitespace between words */
function termPattern(term: string): string {
  let pattern = term.split(/\s+/).map(RegExp.escape).join('\\s+')
  const chars = Array.from(term)
  if (WORD_CHAR.test(chars[0])) pattern = `(?<![\\p{L}\\p{N}_])${pattern}`
  if (WORD_CHAR.test(chars[chars.length - 1]))
    pattern = `${pattern}(?![\\p{L}\\p{N}_])`
  return pattern
}

function compileTerms(terms: string[]): RegExp | null {
  const clean = terms
    .map((term) => term.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  if (!clean.length) return null
  try {
    return new RegExp(clean.map(termPattern).join('|'), 'giu')
  } catch {
    return null
  }
}

export default class Censorship extends TautPlugin<typeof Censorship> {
  static readonly id = 'Censorship'
  static readonly pluginName = 'Censorship'
  static readonly description =
    'Masks words you choose in messages, only on your screen'
  static readonly authors = ['jeremy', 'rowan'] as const
  static readonly category = 'fun'
  static readonly defaultConfig = {
    enabled: false,
    terms: opt.list(
      ['job', 'employment'],
      'Whole words or phrases to mask, case-insensitive'
    ),
    style: opt.select(
      [
        { value: 'stars', label: 'Stars (****)' },
        { value: 'hashtags', label: 'Hashtags (####)' },
        { value: 'blocks', label: 'Blocks (████)' },
        { value: 'custom', label: 'Custom, the replacement below' },
      ],
      'stars',
      'How a masked word looks'
    ),
    replacement: opt(
      'uwu',
      'Shown in place of each masked word when the style is custom'
    ),
    keepFirstLetter: opt(false, 'Leave the first letter of each word showing'),
    keepLastLetter: opt(false, 'Leave the last letter of each word showing'),
  }

  private matcher: RegExp | null = null

  private mask = (match: string): string => {
    const { style, keepFirstLetter, keepLastLetter } = this.config
    if (style === 'custom') return this.config.replacement
    const char = { stars: '*', hashtags: '#', blocks: '█' }[style]
    return match.replace(/\S+/g, (word) =>
      Array.from(word)
        .map((c, i, chars) =>
          (keepFirstLetter && i === 0) ||
          (keepLastLetter && i === chars.length - 1)
            ? c
            : char
        )
        .join('')
    )
  }

  private censorString = (value: string): string => {
    if (!this.matcher) return value
    this.matcher.lastIndex = 0
    return value.replace(this.matcher, this.mask)
  }

  start(): void {
    this.matcher = compileTerms(this.config.terms)
    if (!this.matcher) {
      this.log('No terms configured, nothing to mask')
      return
    }

    this.api.messages.patchMessageText(this.censorString)
    this.log('Started')
  }
}
