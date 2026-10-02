// rewrites links as they come into the composer from outside (a paste, the link dialog), typed text is left alone

import { onChildWindow } from '../childWindows'
import { waitForRenderedComponent } from '../react'
import { byName, waitForExport } from '../webpack'

/** where a link is coming into the composer from */
export interface LinkTransformContext {
  source: 'paste' | 'link-dialog'
}

/** the url to use instead, or the same one to leave it */
export type LinkTransform = (
  url: string,
  context: LinkTransformContext
) => string

const linkTransforms = new Set<LinkTransform>()

/** rewrite links pasted into any composer or added with its link dialog, except into or as code formatting */
export function addLinkTransform(transform: LinkTransform): () => void {
  linkTransforms.add(transform)
  return () => {
    linkTransforms.delete(transform)
  }
}

function transformUrl(url: string, context: LinkTransformContext): string {
  let result = url
  for (const transform of linkTransforms) {
    try {
      const next = transform(result, context)
      if (typeof next === 'string' && next) result = next
    } catch (err) {
      console.error('[Taut] Link transform failed:', err)
    }
  }
  return result
}

/** the text shown for `url` once it becomes `next`, when that text is the url itself or the url without the scheme Slack adds */
function relabel(text: string, url: string, next: string): string {
  if (text === url) return next
  const scheme = url.slice(0, url.length - text.length)
  if (
    text &&
    url.endsWith(text) &&
    /^[a-z][a-z0-9+.-]*:(\/\/)?$/i.test(scheme) &&
    next.startsWith(scheme)
  ) {
    return next.slice(scheme.length)
  }
  return text
}

type DetectLinks = (options: {
  input: string
  ignoreEmailMatches?: boolean
  ignorePhoneMatches?: boolean
}) => { offset: number; text: string; url: string }[]

// the detector Slack linkifies composer text with
let detectLinks: DetectLinks | undefined
waitForExport<DetectLinks>(byName('detectLinks')).then((detect) => {
  detectLinks = detect
})

type Attributes = Record<string, unknown>
type Op = { insert?: unknown; attributes?: Attributes }
type Delta = { ops: Op[] }
type DeltaClass = new (ops?: Op[]) => Delta

/** the pasted ops with their links transformed, or null if nothing changed */
function transformOps(ops: Op[]): Op[] | null {
  const text = ops
    .map((op) => (typeof op.insert === 'string' ? op.insert : '\uFFFC'))
    .join('')
  const inCode: boolean[] = []
  // a code block's format is on the newline that ends each of its lines
  let codeBlockLine = false
  for (let p = text.length - 1, i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]
    const length = typeof op.insert === 'string' ? op.insert.length : 1
    for (let k = length - 1; k >= 0; k--, p--) {
      if (text[p] === '\n') codeBlockLine = !!op.attributes?.['code-block']
      inCode[p] = codeBlockLine || !!op.attributes?.code
    }
  }

  let changed = false
  let at = 0
  const result = ops.map((op) => {
    const start = at
    if (typeof op.insert !== 'string') {
      at += 1
      return op
    }
    at += op.insert.length
    const verbatim = (from: number, to: number) =>
      inCode.slice(start + from, start + to).some(Boolean)
    const link = op.attributes?.link
    if (typeof link === 'string') {
      if (verbatim(0, op.insert.length)) return op
      const next = transformUrl(link, { source: 'paste' })
      if (next === link) return op
      changed = true
      return {
        ...op,
        insert: relabel(op.insert, link, next),
        attributes: { ...op.attributes, link: next },
      }
    }
    if (op.attributes?.unlink || !detectLinks) return op
    const matches = detectLinks({
      input: op.insert,
      ignoreEmailMatches: true,
      ignorePhoneMatches: true,
    })
    let insert = ''
    let last = 0
    for (const match of matches) {
      const { offset } = match
      let { text: shown, url } = match
      // the detector reads mrkdwn's <url|label> as one url
      const end = op.insert[offset - 1] === '<' ? shown.search(/[|>]/) : -1
      if (end > 0 && url.endsWith(shown)) {
        url = url.slice(0, url.length - (shown.length - end))
        shown = shown.slice(0, end)
      }
      if (offset < last || verbatim(offset, offset + shown.length)) continue
      const next = relabel(shown, url, transformUrl(url, { source: 'paste' }))
      if (next === shown) continue
      insert += op.insert.slice(last, offset) + next
      last = offset + shown.length
    }
    if (!last) return op
    changed = true
    return { ...op, insert: insert + op.insert.slice(last) }
  })
  return changed ? result : null
}

type Clipboard = {
  options?: {
    onMarkdownPasteIntercepted?: (paste: { markdownText: string }) => void
  }
}

type PasteArgs = { pastedDelta?: Delta; formats?: Attributes }
type ClipboardPrototype = {
  preparePastedDelta(this: Clipboard, args?: PasteArgs): unknown
  maybeInterceptMarkdownPaste(
    this: Clipboard,
    event: unknown,
    plainPasteIntent?: boolean,
    formats?: Attributes
  ): boolean
}
const patchedClipboards = new WeakSet<object>()

// each window's Quill clipboard module, which every composer paste passes through, reached from a focused editor
function patchClipboard(proto: ClipboardPrototype) {
  if (patchedClipboards.has(proto)) return
  patchedClipboards.add(proto)

  // the pasted content before Slack linkifies it, turns links into link objects and inserts it
  const prepare = proto.preparePastedDelta
  proto.preparePastedDelta = function (args) {
    const delta = args?.pastedDelta
    const formats = args?.formats
    if (
      !linkTransforms.size ||
      !Array.isArray(delta?.ops) ||
      formats?.code ||
      formats?.['code-block']
    ) {
      return prepare.call(this, args)
    }
    try {
      const ops = transformOps(delta.ops)
      if (ops) {
        const pastedDelta = new (delta.constructor as DeltaClass)(ops)
        return prepare.call(this, { ...args, pastedDelta })
      }
    } catch (err) {
      console.error('[Taut] Pasted link transform failed:', err)
    }
    return prepare.call(this, args)
  }

  // markdown-looking pastes into the rich text composer skip the above, and can be sent to Slack to convert
  const intercept = proto.maybeInterceptMarkdownPaste
  proto.maybeInterceptMarkdownPaste = function (...args) {
    const options = this.options
    const intercepted = options?.onMarkdownPasteIntercepted
    const formats = args[2]
    if (
      !options ||
      !intercepted ||
      !linkTransforms.size ||
      formats?.code ||
      formats?.['code-block']
    ) {
      return intercept.apply(this, args)
    }
    options.onMarkdownPasteIntercepted = (paste) => {
      let markdownText = paste.markdownText
      try {
        const ops = transformOps([{ insert: markdownText }])
        if (typeof ops?.[0]?.insert === 'string') markdownText = ops[0].insert
      } catch (err) {
        console.error('[Taut] Pasted link transform failed:', err)
      }
      return intercepted({ ...paste, markdownText })
    }
    try {
      return intercept.apply(this, args)
    } finally {
      options.onMarkdownPasteIntercepted = intercepted
    }
  }
}

function watchEditors(doc: Document) {
  doc.addEventListener(
    'focusin',
    (event) => {
      const target = event.target as Element | null
      const quill = (target?.closest?.('.ql-container') as any)?.__quill
      const clipboard = quill?.getModule?.('clipboard')
      const proto = clipboard && Object.getPrototypeOf(clipboard)
      if (
        typeof proto?.preparePastedDelta === 'function' &&
        typeof proto.maybeInterceptMarkdownPaste === 'function'
      ) {
        patchClipboard(proto)
      }
    },
    true
  )
}
watchEditors(document)
onChildWindow(watchEditors)

type SavedLink = { didTextChange: boolean; text: string; url: string }

// the add and edit link dialog, whose save gets the url already normalized (a scheme added)
waitForRenderedComponent('ComposerLinkModal').then((modal: any) => {
  // what renders first is Slack's connect memo around the class, under the same name
  const proto = (modal?.type ?? modal)?.prototype
  if (typeof proto?.saveLink !== 'function') return
  const save = proto.saveLink
  proto.saveLink = function (link: SavedLink) {
    if (!linkTransforms.size || typeof link?.url !== 'string') {
      return save.call(this, link)
    }
    const url = transformUrl(link.url, { source: 'link-dialog' })
    if (url === link.url) return save.call(this, link)
    const text = relabel(link.text, link.url, url)
    return save.call(this, {
      ...link,
      url,
      text,
      didTextChange: link.didTextChange || text !== link.text,
    })
  }
})
