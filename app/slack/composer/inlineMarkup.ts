// replaces Slack's `*bold*` style shortcuts, as you type (rich text mode) and on send (plain text mode)

import type { Block, RichTextElement } from '../blocks'
import { onChildWindow } from '../childWindows'
import { byName, patchFunctionExport } from '../webpack'

export type InlineFormat =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | { link: string }

/** one piece of markup, as offsets into the text `parse` was given */
export interface MarkupSpan {
  /** where the markup starts, opening marker included */
  start: number
  /** where it ends, closing marker included */
  end: number
  /** the visible part is `[contentStart, contentEnd)`, the rest of `[start, end)` is removed */
  contentStart: number
  contentEnd: number
  /** applied to the visible part, null only removes the markers (an escape) */
  format: InlineFormat | null
}

export interface InlineMarkup {
  /** one line of text, never code, with embeds as U+FFFC, spans may nest but not partly overlap */
  parse(text: string): MarkupSpan[]
  /** markers around formatted text, for when plain text mode shows an existing message as markup */
  serialize(format: InlineFormat): [open: string, close: string]
  /** make literal text read back as itself, like by escaping marker characters */
  escape(text: string): string
}

let activeMarkup: InlineMarkup | undefined

/** replace Slack's inline formatting shortcuts in the composer, one markup at a time */
export function patchInlineMarkup(markup: InlineMarkup): () => void {
  if (activeMarkup) throw new Error('[Taut] Inline markup is already patched')
  activeMarkup = markup
  return () => {
    if (activeMarkup === markup) activeMarkup = undefined
  }
}

type Attributes = Record<string, unknown>
type Op = {
  insert?: string | object
  retain?: number
  delete?: number
  attributes?: Attributes
}
interface Delta {
  ops: Op[]
  retain(length: number, attributes?: Attributes): Delta
  insert(text: string, attributes?: Attributes): Delta
  delete(length: number): Delta
  compose(other: Delta): Delta
  length(): number
}
type DeltaClass = new (ops?: Op[]) => Delta

const INLINE_FORMATS = ['bold', 'italic', 'strike', 'code'] as const

type Char = { char: string; attributes?: Attributes }

/** the document as one entry per Quill position */
function charsOf(delta: Delta): Char[] {
  const chars: Char[] = []
  for (const op of delta.ops) {
    if (typeof op.insert === 'string') {
      // one entry per UTF-16 unit, which is what Quill counts
      for (let i = 0; i < op.insert.length; i++) {
        chars.push({ char: op.insert[i], attributes: op.attributes })
      }
    } else if (op.insert) {
      // an embed, as the object replacement character
      chars.push({ char: '\uFFFC', attributes: op.attributes })
    }
  }
  return chars
}

/** positions inside closed ``` fences, and after an unclosed one */
function fencedPositions(chars: Char[]): Set<number> {
  const text = chars.map((c) => c.char).join('')
  const fenced = new Set<number>()
  const fences = [...text.matchAll(/```/g)].map((m) => m.index)
  for (let i = 0; i < fences.length; i += 2) {
    const from = fences[i]
    const to = i + 1 < fences.length ? fences[i + 1] + 3 : text.length
    for (let p = from; p < to; p++) fenced.add(p)
  }
  return fenced
}

type Run = { start: number; text: string }

/** runs of parseable text in `[from, to)`, never code or fences and never across a line break */
function runsOf(chars: Char[], from = 0, to = chars.length): Run[] {
  const fenced = fencedPositions(chars)
  const runs: Run[] = []
  let lineStart = from
  const flushLine = (lineEnd: number) => {
    const newline = chars[lineEnd]
    if (newline?.attributes?.['code-block']) return
    let run: Run | null = null
    for (let p = lineStart; p < lineEnd; p++) {
      const c = chars[p]
      if (fenced.has(p) || c.attributes?.code) {
        run = null
        continue
      }
      if (!run) {
        run = { start: p, text: '' }
        runs.push(run)
      }
      run.text += c.char
    }
  }
  for (let p = from; p < to; p++) {
    if (chars[p].char === '\n') {
      flushLine(p)
      lineStart = p + 1
    }
  }
  flushLine(to)
  return runs
}

function formatAttributes(format: InlineFormat): Attributes {
  return typeof format === 'string' ? { [format]: true } : { link: format.link }
}

type Plan = { removed: boolean; escaped?: boolean; attributes?: Attributes }

type Change = {
  change: Delta
  /** where escaped characters end up, which must stay literal */
  escaped: number[]
}

/** a change delta that removes the spans' markers and formats their content */
function changeFor(
  Delta: DeltaClass,
  length: number,
  spans: { offset: number; span: MarkupSpan }[]
): Change | null {
  if (!spans.length) return null
  const plan: Plan[] = Array.from({ length }, () => ({ removed: false }))
  for (const { offset, span } of spans) {
    for (let p = span.start; p < span.end; p++) {
      const at = plan[offset + p]
      if (!at) continue
      if (p < span.contentStart || p >= span.contentEnd) at.removed = true
      else if (span.format) {
        at.attributes = { ...at.attributes, ...formatAttributes(span.format) }
      } else at.escaped = true
    }
  }
  const escaped: number[] = []
  let output = 0
  for (const at of plan) {
    if (at.removed) continue
    if (at.escaped) escaped.push(output)
    output++
  }
  const change = new Delta()
  let p = 0
  while (p < length) {
    const here = plan[p]
    let q = p + 1
    const same = (other: Plan) =>
      other.removed === here.removed &&
      JSON.stringify(other.attributes) === JSON.stringify(here.attributes)
    while (q < length && same(plan[q])) q++
    if (here.removed) change.delete(q - p)
    else change.retain(q - p, here.attributes)
    p = q
  }
  return { change, escaped }
}

/** swap the characters at `positions` for private-use stand-ins from U+E000 that Slack's rules can't match */
function maskChange(doc: Delta, positions: number[]) {
  const Delta = doc.constructor as DeltaClass
  const chars = charsOf(doc)
  const originals: string[] = []
  const mask = new Delta()
  let last = 0
  for (const p of positions) {
    const c = chars[p]
    if (!c) continue
    mask.retain(p - last).delete(1)
    mask.insert(String.fromCharCode(0xe000 + originals.length), c.attributes)
    originals.push(c.char)
    last = p + 1
  }
  const unmask = (masked: Delta) => {
    const back = new Delta()
    let at = 0
    let previous = 0
    for (const c of charsOf(masked)) {
      const i = c.char.charCodeAt(0) - 0xe000
      if (c.char.length === 1 && i >= 0 && i < originals.length) {
        back
          .retain(at - previous)
          .delete(1)
          .insert(originals[i], c.attributes)
        previous = at + 1
      }
      at++
    }
    return back
  }
  return { mask, unmask }
}

function parseRuns(markup: InlineMarkup, runs: Run[]) {
  const found: { offset: number; span: MarkupSpan }[] = []
  for (const run of runs) {
    for (const span of markup.parse(run.text)) {
      found.push({ offset: run.start, span })
    }
  }
  return found
}

// used by plain text mode, "convert markdown" and paste, Slack's conversion still does code blocks, lists and quotes
patchFunctionExport(
  byName('buildMarkdownChangeDelta'),
  (original) =>
    function buildMarkdownChangeDelta(delta: Delta, ...rest: unknown[]) {
      const markup = activeMarkup
      if (!markup || !delta?.ops) return original(delta, ...rest)
      let ours: Change | null = null
      try {
        const chars = charsOf(delta)
        ours = changeFor(
          delta.constructor as DeltaClass,
          chars.length,
          parseRuns(markup, runsOf(chars))
        )
      } catch (err) {
        console.error('[Taut] Inline markup failed:', err)
      }
      if (!ours) return original(delta, ...rest)
      const applied = delta.compose(ours.change)
      if (!ours.escaped.length) {
        return ours.change.compose(original(applied, ...rest))
      }
      const { mask, unmask } = maskChange(applied, ours.escaped)
      const masked = applied.compose(mask)
      const slack = original(masked, ...rest)
      return ours.change
        .compose(mask)
        .compose(slack)
        .compose(unmask(masked.compose(slack)))
    }
)

const isInlineFormatting = (change: Delta | undefined) =>
  !!change?.ops?.some((op) =>
    INLINE_FORMATS.some((format) => op.attributes?.[format] !== undefined)
  )

/** where the keystroke landed, from Slack's `[retain?, insert]` change */
function typedAt(change: Delta | undefined): number | null {
  const ops = change?.ops
  if (!ops?.length || ops.length > 2) return null
  const [first, second] = ops.length === 2 ? ops : [{ retain: 0 }, ops[0]]
  if (typeof first.retain !== 'number') return null
  if (typeof second.insert !== 'string' || !second.insert) return null
  return first.retain + second.insert.length
}

/** the change for markup closed by the character just typed at `cursor` */
function changeForTyping(
  contents: Delta,
  cursor: number,
  markup: InlineMarkup
): Delta | null {
  const chars = charsOf(contents)
  let lineStart = cursor - 1
  while (lineStart > 0 && chars[lineStart - 1]?.char !== '\n') lineStart--
  let lineEnd = cursor
  while (lineEnd < chars.length && chars[lineEnd].char !== '\n') lineEnd++
  const found = parseRuns(
    markup,
    runsOf(chars, Math.max(0, lineStart), lineEnd)
  )
  // spans closed by this keystroke, and whatever sits inside them
  const closing = found.filter(
    ({ offset, span }) => offset + span.end === cursor
  )
  if (!closing.length) return null
  const inside = found.filter(({ offset, span }) =>
    closing.some(
      (c) =>
        c.offset + c.span.start <= offset + span.start &&
        offset + span.end <= c.offset + c.span.end
    )
  )
  return (
    changeFor(contents.constructor as DeltaClass, chars.length, inside)
      ?.change ?? null
  )
}

type MarkdownModule = {
  buildTextChangeDelta(contents: Delta, options?: any): Delta | undefined
  /** formats Slack turns off at the cursor once the change is applied */
  formatsAppliedInQueue?: string[] | null
}
const patchedModules = new WeakSet<object>()

// as-you-type formatting is each window's Quill `slackmarkdown` module, reached from a focused editor
function patchMarkdownModule(proto: MarkdownModule) {
  if (patchedModules.has(proto)) return
  patchedModules.add(proto)
  const original = proto.buildTextChangeDelta
  proto.buildTextChangeDelta = function (
    this: MarkdownModule,
    contents,
    options = {}
  ) {
    const result = original.call(this, contents, options)
    const markup = activeMarkup
    if (!markup || !options.useWysiwyg || options.formattingOnly) return result
    try {
      const cursor = typedAt(options.initialTextChangeDelta)
      if (cursor === null) return result
      const ours = changeForTyping(contents, cursor, markup)
      if (ours) {
        // like Slack's: what was just formatted doesn't carry on typing
        this.formatsAppliedInQueue = [...INLINE_FORMATS, 'link']
        return ours
      }
      // Slack's inline shortcuts are replaced, its block ones are kept
      if (isInlineFormatting(result)) {
        this.formatsAppliedInQueue = null
        return new (contents.constructor as DeltaClass)()
      }
    } catch (err) {
      console.error('[Taut] Inline markup failed:', err)
    }
    return result
  }
}

function watchEditors(doc: Document) {
  doc.addEventListener(
    'focusin',
    (event) => {
      const target = event.target as Element | null
      const quill = (target?.closest?.('.ql-container') as any)?.__quill
      const module = quill?.getModule?.('slackmarkdown')
      if (!module) return
      const proto = Object.getPrototypeOf(module)
      if (typeof proto?.buildTextChangeDelta === 'function') {
        patchMarkdownModule(proto)
      }
    },
    true
  )
}
watchEditors(document)
onChildWindow(watchEditors)

/** styled elements as marker text, so Slack's converter writes `serialize`'s markup instead of its own */
function serializeElements(
  elements: RichTextElement[],
  markup: InlineMarkup
): RichTextElement[] {
  const out: RichTextElement[] = []
  const open: InlineFormat[] = []
  let pendingSpace = ''
  const text = (value: string) => {
    if (value) out.push({ type: 'text', text: value })
  }
  const closeTo = (depth: number) => {
    while (open.length > depth) {
      const format = open.pop() as InlineFormat
      text(markup.serialize(format)[1])
    }
  }
  const place = (styles: InlineFormat[], element: RichTextElement | null) => {
    let keep = 0
    while (keep < open.length && styles.includes(open[keep])) keep++
    closeTo(keep)
    text(pendingSpace)
    pendingSpace = ''
    for (const format of styles) {
      if (open.includes(format)) continue
      open.push(format)
      text(markup.serialize(format)[0])
    }
    if (element) out.push(element)
  }
  for (const element of elements) {
    const styles = INLINE_FORMATS.filter((key) => element.style?.[key])
    const { style: _style, ...unstyled } = element
    if (element.type === 'link' && element.text && !element.style?.code) {
      place(styles, null)
      const [before, after] = markup.serialize({ link: String(element.url) })
      text(before + element.text + after)
      continue
    }
    if (element.type === 'text' && typeof element.text === 'string') {
      // whitespace goes outside markers: `**bold** ` rather than `**bold **`
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(
        element.text
      ) as RegExpExecArray
      if (!core) {
        pendingSpace += element.text
        continue
      }
      pendingSpace += lead
      const literal = element.style?.code ? core : markup.escape(core)
      place(styles, { ...unstyled, text: literal })
      pendingSpace += trail
      continue
    }
    place(styles, styles.length ? (unstyled as RichTextElement) : element)
  }
  closeTo(0)
  text(pendingSpace)
  return out
}

function serializeBlocks(blocks: Block[], markup: InlineMarkup): Block[] {
  return blocks.map((block) => {
    if (block?.type !== 'rich_text' || !Array.isArray(block.elements)) {
      return block
    }
    const serializeContainer = (container: any): any => {
      if (container?.type === 'rich_text_preformatted') return container
      const elements = container?.elements
      if (!Array.isArray(elements)) return container
      if (elements.some((e: any) => Array.isArray(e?.elements))) {
        return { ...container, elements: elements.map(serializeContainer) }
      }
      return { ...container, elements: serializeElements(elements, markup) }
    }
    return serializeContainer(block)
  })
}

// plain text mode shows a message as markup when you edit it or open a scheduled one
patchFunctionExport(
  byName('convertBlocksToMrkdwnDelta'),
  (original) =>
    function convertBlocksToMrkdwnDelta(
      state: unknown,
      blocks: Block[],
      ...rest: unknown[]
    ) {
      const markup = activeMarkup
      if (!markup || !Array.isArray(blocks)) {
        return original(state, blocks, ...rest)
      }
      try {
        return original(state, serializeBlocks(blocks, markup), ...rest)
      } catch (err) {
        console.error('[Taut] Inline markup serialize failed:', err)
        return original(state, blocks, ...rest)
      }
    }
)
