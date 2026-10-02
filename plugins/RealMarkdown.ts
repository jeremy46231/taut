// Write messages in standard Markdown instead of Slack's markup

import { type InlineFormat, type MarkupSpan, TautPlugin } from '$taut'

type Emphasis = { marker: string; format: InlineFormat }

// longest first, so `**` is tried before `*`
const EMPHASIS: Emphasis[] = [
  { marker: '**', format: 'bold' },
  { marker: '__', format: 'bold' },
  { marker: '~~', format: 'strike' },
  { marker: '*', format: 'italic' },
  { marker: '_', format: 'italic' },
]
const ESCAPABLE = new Set(['\\', '`', '*', '_', '~', '[', ']', '(', ')'])
const isWord = (char: string) => /[\p{L}\p{N}]/u.test(char)
const isSpace = (char: string) => /\s/.test(char)

function escaped(text: string, at: number): boolean {
  let slashes = 0
  for (let i = at - 1; i >= 0 && text[i] === '\\'; i--) slashes++
  return slashes % 2 === 1
}

function canOpen(text: string, at: number, from: number, marker: string) {
  // the start of the range being scanned counts as a boundary
  const previous = at > from ? text[at - 1] : ' '
  const next = text[at + marker.length] ?? ''
  if (!next || isSpace(next)) return false
  // a single marker next to its twin belongs to a double one
  if (marker.length === 1 && (previous === marker || next === marker)) {
    return false
  }
  if (marker[0] === '_' && isWord(previous)) return false
  return true
}

function canClose(text: string, at: number, marker: string): boolean {
  const previous = text[at - 1] ?? ''
  const next = text[at + marker.length] ?? ''
  if (!previous || isSpace(previous)) return false
  if (marker[0] === '_' && isWord(next)) return false
  return true
}

function findClose(text: string, marker: string, from: number, to: number) {
  for (
    let at = text.indexOf(marker, from);
    at !== -1 && at + marker.length <= to;
    at = text.indexOf(marker, at + 1)
  ) {
    if (escaped(text, at) || !canClose(text, at, marker)) continue
    // in `***x***` the final two close the bold, leaving one for the italic
    const after = at + marker.length < to ? text[at + marker.length] : ''
    if (marker.length === 2 && after === marker[0]) continue
    if (marker.length === 1 && after === marker) continue
    return at
  }
  return -1
}

/** the `)` ending a link destination, allowing balanced parentheses in it */
function linkEnd(text: string, from: number, to: number): number {
  let depth = 0
  for (let at = from; at < to; at++) {
    if (escaped(text, at)) continue
    if (text[at] === '(') depth++
    if (text[at] === ')' && depth-- === 0) return at
  }
  return -1
}

/** Markdown inline markup in `text[from, to)` */
function scan(text: string, from: number, to: number, spans: MarkupSpan[]) {
  for (let at = from; at < to; ) {
    const char = text[at]

    if (char === '\\' && at + 1 < to && ESCAPABLE.has(text[at + 1])) {
      spans.push({
        start: at,
        end: at + 2,
        contentStart: at + 1,
        contentEnd: at + 2,
        format: null,
      })
      at += 2
      continue
    }

    // bare URLs are left alone, they are full of `_` and `*`
    if (
      (text.startsWith('https://', at) || text.startsWith('http://', at)) &&
      !isWord(text[at - 1] ?? '')
    ) {
      while (at < to && !isSpace(text[at])) at++
      continue
    }

    if (char === '`') {
      const end = text.indexOf('`', at + 1)
      // a code span still being typed, so nothing after it is markup yet
      if (end === -1 || end >= to) return
      if (end > at + 1) {
        spans.push({
          start: at,
          end: end + 1,
          contentStart: at + 1,
          contentEnd: end,
          format: 'code',
        })
        at = end + 1
        continue
      }
    }

    let matched = false
    for (const { marker, format } of EMPHASIS) {
      if (!text.startsWith(marker, at) || escaped(text, at)) continue
      if (!canOpen(text, at, from, marker)) continue
      const end = findClose(text, marker, at + marker.length, to)
      if (end === -1) continue
      const contentStart = at + marker.length
      spans.push({
        start: at,
        end: end + marker.length,
        contentStart,
        contentEnd: end,
        format,
      })
      scan(text, contentStart, end, spans)
      at = end + marker.length
      matched = true
      break
    }
    if (matched) continue

    if (char === '[' && !escaped(text, at)) {
      const labelEnd = text.indexOf('](', at + 1)
      if (labelEnd > at + 1 && labelEnd < to) {
        const end = linkEnd(text, labelEnd + 2, to)
        const url = end === -1 ? '' : text.slice(labelEnd + 2, end)
        if (/^(https?:\/\/|mailto:)\S+$/i.test(url)) {
          spans.push({
            start: at,
            end: end + 1,
            contentStart: at + 1,
            contentEnd: labelEnd,
            format: { link: url },
          })
          scan(text, at + 1, labelEnd, spans)
          at = end + 1
          continue
        }
      }
    }

    at++
  }
}

function parseMarkdown(text: string): MarkupSpan[] {
  const spans: MarkupSpan[] = []
  scan(text, 0, text.length, spans)
  return spans
}

/** escapes markers in literal text that would read as markup */
function escapeMarkdown(text: string): string {
  if (!parseMarkdown(text).length) return text
  // bare URLs are never parsed, so leave them unescaped
  return text
    .split(/(https?:\/\/\S+)/)
    .map((part, i) => (i % 2 ? part : part.replace(/[\\`*_~[\]]/g, '\\$&')))
    .join('')
}

function serializeMarkdown(format: InlineFormat): [string, string] {
  if (typeof format === 'object') return ['[', `](${format.link})`]
  switch (format) {
    case 'bold':
      return ['**', '**']
    case 'italic':
      return ['_', '_']
    case 'strike':
      return ['~~', '~~']
    case 'code':
      return ['`', '`']
  }
}

export default class RealMarkdown extends TautPlugin<typeof RealMarkdown> {
  static readonly id = 'RealMarkdown'
  static readonly pluginName = 'Real Markdown'
  static readonly description =
    "Write messages in standard Markdown instead of Slack's markup"
  static readonly authors = ['jeremy', 'rowan'] as const
  static readonly category = 'messageBox'
  static readonly defaultConfig = {
    enabled: false,
  }

  start() {
    this.api.composer.patchInlineMarkup({
      parse: parseMarkdown,
      serialize: serializeMarkdown,
      escape: escapeMarkdown,
    })
    this.log('Started')
  }
}
