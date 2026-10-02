// every way of sending, in both composer modes, passes through one of the patches below

import type { Block, RichTextElement } from './blocks'
import { mapRichTextElements } from './blocks'
import { patchThunk, waitForThunkCreator } from './redux'

/** must be idempotent, since a resend or a rescheduled draft passes its own output back in */
export type MessageSendTransform = (blocks: Block[]) => Block[]

const transforms = new Set<MessageSendTransform>()

function transformBlocks(blocks: Block[]): Block[] {
  let result = blocks
  for (const transform of transforms) {
    try {
      const next = transform(result)
      if (Array.isArray(next)) result = next
    } catch (err) {
      console.error('[Taut] Message send transform failed:', err)
    }
  }
  return result
}

/** transform the Block Kit of every message you send, edit or schedule */
export function onMessageSendBlocks(
  transform: MessageSendTransform
): () => void {
  transforms.add(transform)
  return () => {
    transforms.delete(transform)
  }
}

function parseArray(value: unknown): any[] | undefined {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function linkUrls(blocks: Block[]): string[] {
  const urls: string[] = []
  mapRichTextElements(blocks, (element: RichTextElement) => {
    if (element.type === 'link' && typeof element.url === 'string') {
      urls.push(element.url)
    }
    return element
  })
  return urls
}

/** Slack asks the server to unfurl the urls the composer saw, so the list follows rewritten links */
function remapUnfurls(
  unfurl: unknown,
  before: Block[],
  after: Block[]
): unknown {
  const from = linkUrls(before)
  const to = linkUrls(after)
  if (from.length !== to.length) return unfurl
  const renamed = new Map<string, string>()
  from.forEach((url, i) => {
    if (url !== to[i]) renamed.set(url, to[i])
  })
  if (!renamed.size) return unfurl
  const list = parseArray(unfurl)
  if (!list) return unfurl
  const next = list.map((entry: any) =>
    typeof entry?.url === 'string' && renamed.has(entry.url)
      ? { ...entry, url: renamed.get(entry.url) }
      : entry
  )
  return typeof unfurl === 'string' ? JSON.stringify(next) : next
}

const FORMAT_TIMEOUT_MS = 5000

type Dispatch = (action: unknown) => any

/** the markdown composer's text as blocks, using the same api call the preview uses */
async function markdownToBlocks(
  dispatch: Dispatch,
  markdown: string
): Promise<Block[] | undefined> {
  // bounded, since a send waits on this
  const format = await Promise.race([
    waitForThunkCreator('blocksFormatFetcher'),
    new Promise<undefined>((resolve) => setTimeout(resolve, FORMAT_TIMEOUT_MS)),
  ])
  if (!format) return undefined
  try {
    const res = await dispatch(
      format({
        blocks: JSON.stringify([{ type: 'markdown', text: markdown }]),
        reason: 'taut-markdown-send',
        abortSignal: AbortSignal.timeout(FORMAT_TIMEOUT_MS),
      })
    )
    return Array.isArray(res?.blocks) ? res.blocks : undefined
  } catch (err) {
    console.warn('[Taut] Could not convert markdown for send transforms:', err)
    return undefined
  }
}

/** `args` sending `blocks` after the transforms, undefined if they changed nothing */
function transformArgs(args: any, blocks: Block[]): any {
  const after = transformBlocks(blocks)
  if (after === blocks) return undefined
  const changed = { ...args, blocks: after }
  if (args.unfurl) changed.unfurl = remapUnfurls(args.unfurl, blocks, after)
  // the api refuses markdown_text next to blocks
  delete changed.markdown_text
  return changed
}

const markdownOnly = (args: any): string | undefined =>
  typeof args?.markdown_text === 'string' &&
  args.markdown_text &&
  !parseArray(args.blocks)
    ? args.markdown_text
    : undefined

// sends, thread replies and resends, with the blocks for both the pending message and the api payload
patchThunk('sendMessage', (original) => (args: any, ...rest: any[]) => {
  if (!transforms.size) return original(args, ...rest)
  const markdown = markdownOnly(args)
  if (markdown)
    // the markdown editor sends only text, the preview also passes its blocks
    return async (dispatch: Dispatch) => {
      const blocks = await markdownToBlocks(dispatch, markdown)
      const changed = blocks && transformArgs(args, blocks)
      return dispatch(original(changed ?? args, ...rest))
    }
  if (!Array.isArray(args?.blocks)) return original(args, ...rest)
  return original(transformArgs(args, args.blocks) ?? args, ...rest)
})

// the optimistic edit is drawn from what the thunk dispatches synchronously, before chat.update
patchThunk('saveMessageEdit', (original) => (...args: any[]) => {
  const thunk = original(...args)
  if (typeof thunk !== 'function') return thunk
  return (dispatch: (action: any) => any, ...rest: any[]) => {
    let synchronous = true
    const transformingDispatch = (action: any) => {
      const payload = action?.payload
      if (
        synchronous &&
        transforms.size &&
        typeof action === 'object' &&
        Array.isArray(payload?.blocks) &&
        typeof payload.ts === 'string' &&
        typeof payload.channelId === 'string'
      ) {
        const blocks = transformBlocks(payload.blocks)
        if (blocks !== payload.blocks) {
          action = { ...action, payload: { ...payload, blocks } }
        }
      }
      return dispatch(action)
    }
    try {
      return thunk(transformingDispatch, ...rest)
    } finally {
      synchronous = false
    }
  }
})

const API_METHODS = new Set([
  'chat.postMessage',
  'chat.update',
  'chat.shareMessage',
  'files.share',
  'files.uploadExternal',
  'drafts.create',
  'drafts.update',
])

function transformApiCall(options: any): any {
  const method = options?.method
  const args = options?.args
  if (!API_METHODS.has(method) || !args || !transforms.size) return options
  // scheduled messages are drafts, and only those have a date
  if (method.startsWith('drafts.') && !args.date_scheduled) return options
  const blocks = parseArray(args.blocks)
  if (!blocks) return options
  const next = transformBlocks(blocks)
  if (next === blocks) return options
  const changed = {
    ...args,
    blocks: typeof args.blocks === 'string' ? JSON.stringify(next) : next,
  }
  if (args.unfurl) changed.unfurl = remapUnfurls(args.unfurl, blocks, next)
  return { ...options, args: changed }
}

// the rest at the wire: edits, scheduled drafts, file shares, forwards
for (const name of ['apiCall', 'apiCallExpedited']) {
  patchThunk(name, (original) => (options: any, ...rest: any[]) => {
    const markdown = markdownOnly(options?.args)
    if (!transforms.size || options?.method !== 'chat.update' || !markdown)
      return original(transformApiCall(options), ...rest)
    return async (dispatch: Dispatch) => {
      const blocks = await markdownToBlocks(dispatch, markdown)
      const changed = blocks && transformArgs(options.args, blocks)
      if (!changed) return dispatch(original(options, ...rest))
      const args = { ...changed, blocks: JSON.stringify(changed.blocks) }
      return dispatch(original({ ...options, args }, ...rest))
    }
  })
}
