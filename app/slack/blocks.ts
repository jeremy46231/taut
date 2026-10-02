import { getReduxStore } from './redux'
import { byName, waitForExport } from './webpack'

/** one Block Kit block, Slack's composer produces `rich_text` ones */
export type Block = Record<string, unknown>

/** one inline piece of a `rich_text` block: `text`, `link`, `emoji`, `user`, ... */
export type RichTextElement = {
  type: string
  text?: string
  url?: string
  style?: Record<string, boolean | undefined>
  [key: string]: unknown
}

export interface RichTextElementContext {
  /** inside a code span or a preformatted block */
  inCode: boolean
  /** the element holding it: `rich_text_section`, `rich_text_quote`, `rich_text_preformatted`, ... */
  container: string
}

export interface RichTextSectionContext {
  /** the run's type: `rich_text_section`, `rich_text_quote`, `rich_text_preformatted`, ... */
  container: string
  /** the run's parent: `rich_text` at the top level, `rich_text_list` for a list item */
  parent: string
  /** the run's position in the message, from 0 */
  index: number
}

type Container = { type?: string; elements?: unknown[] }

const isContainer = (value: unknown): value is Container =>
  !!value &&
  typeof value === 'object' &&
  Array.isArray((value as Container).elements)

function mapContainer(
  container: Container,
  map: (element: RichTextElement, context: RichTextElementContext) => unknown
): Container {
  const elements = container.elements ?? []
  const next: unknown[] = []
  let changed = false
  for (const element of elements) {
    if (isContainer(element)) {
      const mapped = mapContainer(element, map)
      if (mapped !== element) changed = true
      next.push(mapped)
      continue
    }
    const mapped = map(element as RichTextElement, {
      inCode:
        container.type === 'rich_text_preformatted' ||
        !!(element as RichTextElement).style?.code,
      container: container.type ?? '',
    })
    if (Array.isArray(mapped)) {
      changed = true
      next.push(...mapped)
    } else {
      if (mapped !== element) changed = true
      next.push(mapped)
    }
  }
  return changed ? { ...container, elements: next } : container
}

/** `map` returns an element or an array to replace it ([] drops it), unchanged blocks keep their identity */
export function mapRichTextElements(
  blocks: Block[],
  map: (
    element: RichTextElement,
    context: RichTextElementContext
  ) => RichTextElement | RichTextElement[]
): Block[] {
  let changed = false
  const next = blocks.map((block) => {
    if (block?.type !== 'rich_text' || !isContainer(block)) return block
    const mapped = mapContainer(block, map) as Block
    if (mapped !== block) changed = true
    return mapped
  })
  return changed ? next : blocks
}

/** maps each run of inline elements (section, quote, preformatted block or list item) as a whole, unchanged blocks keep their identity */
export function mapRichTextSections(
  blocks: Block[],
  map: (
    elements: RichTextElement[],
    context: RichTextSectionContext
  ) => RichTextElement[]
): Block[] {
  let index = 0
  const visit = (container: Container, parent: string): Container => {
    const elements = container.elements ?? []
    if (container.type !== 'rich_text' && !elements.some(isContainer)) {
      const mapped = map(elements as RichTextElement[], {
        container: container.type ?? '',
        parent,
        index: index++,
      })
      return mapped === elements
        ? container
        : { ...container, elements: mapped }
    }
    let changed = false
    const next = elements.map((element) => {
      if (!isContainer(element)) return element
      const mapped = visit(element, container.type ?? '')
      if (mapped !== element) changed = true
      return mapped
    })
    return changed ? { ...container, elements: next } : container
  }
  let changed = false
  const next = blocks.map((block) => {
    if (block?.type !== 'rich_text' || !isContainer(block)) return block
    const mapped = visit(block, '') as Block
    if (mapped !== block) changed = true
    return mapped
  })
  return changed ? next : blocks
}

type DeltaOp = (
  | { insert?: string | object }
  | { delete?: number }
  | { retain?: number }
) & {
  attributes?: Record<string, unknown>
}

/** a Quill Delta, see https://github.com/slab/delta, only for app/slack since not every message box uses them */
export declare class Delta {
  // the brand keeps a plain `{ ops: [...] }` from satisfying this type
  private _quillDeltaBrand: never
  ops: DeltaOp[]
}

/** all default to off inside Slack */
export interface FromDraftOptions {
  convertEmpty?: boolean
  trimEndingWhitespace?: boolean
  trimStartingWhitespace?: boolean
  expandTruncatedLinks?: boolean
  useExpandedRichText?: boolean
  splitSectionsOnNewlines?: boolean
  supportNonRichTextBlocks?: boolean
  useRichTextHeadersAndDividers?: boolean
}

type ConvertDeltaToBlocks = (arg: {
  delta: Delta
  options?: FromDraftOptions
  state: unknown
}) => { blocks?: Block[] } | undefined

type ConvertBlocksToText = (state: unknown, blocks: Block[]) => string
type ConvertBlocksToDelta = (state: unknown, blocks: Block[]) => Delta
type DeltaConstructor = new (ops?: unknown[]) => Delta

/** Quill's Delta class, identified by its prototype rather than by name */
const isDelta = (exp: unknown) => {
  if (typeof exp !== 'function' || !exp.prototype) return false
  const proto = exp.prototype
  return (
    typeof proto.insert === 'function' &&
    typeof proto.retain === 'function' &&
    typeof proto.concat === 'function' &&
    typeof proto.compose === 'function'
  )
}

export const blocksPromise = (async () => {
  const deltaToBlocks = waitForExport<ConvertDeltaToBlocks>(
    byName('convertDeltaToBlocks')
  )
  const blocksToPlainText = waitForExport<ConvertBlocksToText>(
    byName('convertBlocksToPlainText')
  )
  const blocksToMarkdown = waitForExport<ConvertBlocksToText>(
    byName('convertBlocksToMarkdown')
  )
  const blocksToDelta = waitForExport<ConvertBlocksToDelta>(
    byName('convertBlocksToDelta')
  )
  const deltaClass = waitForExport<DeltaConstructor>(isDelta)

  function state(): unknown {
    const store = getReduxStore()
    if (!store) throw new Error('[Taut] Block Kit: redux store unavailable')
    return store.getState()
  }

  /** Slack resolves mentions, links and formatting as its composer would */
  async function fromDelta(
    delta: Delta,
    options?: FromDraftOptions
  ): Promise<Block[]> {
    const convert = await deltaToBlocks
    return convert({ delta, options, state: state() })?.blocks ?? []
  }

  /** a stored draft's raw `ops` as Block Kit */
  async function fromDraft(
    ops: unknown[],
    options?: FromDraftOptions
  ): Promise<Block[]> {
    const Delta = await deltaClass
    return fromDelta(new Delta(ops), options)
  }

  /** Block Kit to composer content, the reverse of `fromDelta` */
  async function toDelta(blocks: Block[]): Promise<Delta> {
    return (await blocksToDelta)(state(), blocks)
  }

  /** plain text, for a notification or search fallback */
  async function toPlainText(blocks: Block[]): Promise<string> {
    return (await blocksToPlainText)(state(), blocks)
  }

  /** mentions and links resolve to names */
  async function toMarkdown(blocks: Block[]): Promise<string> {
    return (await blocksToMarkdown)(state(), blocks)
  }

  return {
    fromDelta,
    toDelta,
    fromDraft,
    toPlainText,
    toMarkdown,
    mapRichTextElements,
    mapRichTextSections,
  }
})()

export const blocksAPIPromise = blocksPromise.then(
  ({
    fromDraft,
    toPlainText,
    toMarkdown,
    mapRichTextElements,
    mapRichTextSections,
  }) => ({
    fromDraft,
    toPlainText,
    toMarkdown,
    mapRichTextElements,
    mapRichTextSections,
  })
)
