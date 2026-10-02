import { patchThunk } from './redux'
import { patchModuleExports } from './webpack'

export type RtmEvent = {
  type?: string
  subtype?: string
  channel?: string
  user?: string
  ts?: string
  event_ts?: string
  bot_id?: string
  app_id?: string
  message?: RtmEvent
  edited?: { user?: string; ts?: string }
  [key: string]: unknown
}

export type RtmListener = (event: RtmEvent) => void

const listeners = new Map<string, Set<RtmListener>>()

function emit(type: string | undefined, event: RtmEvent | undefined): void {
  if (!type || !event) return
  for (const key of [type, '*']) {
    const set = listeners.get(key)
    if (!set) continue
    for (const listener of [...set]) {
      try {
        listener(event)
      } catch (err) {
        console.error(`[Taut] RTM listener for ${key} threw`, err)
      }
    }
  }
}

type RoutedBatch = {
  messages?: { rtmEventType?: string; msgs?: RtmEvent[] }
}

// everything the socket delivers is routed here, handler or not
patchModuleExports((exports) => {
  if (!exports || typeof exports !== 'object') return
  for (const key of Object.keys(exports)) {
    let value: any
    try {
      value = exports[key]
    } catch {
      continue
    }
    if (typeof value !== 'function' || value.name !== 'routeMessages') continue

    const original = value
    const wrapped = (batch: RoutedBatch, ...rest: any[]) => {
      const { rtmEventType, msgs } = batch?.messages ?? {}
      for (const msg of msgs ?? []) emit(rtmEventType ?? msg?.type, msg)
      return original(batch, ...rest)
    }
    const descriptors = Object.getOwnPropertyDescriptors(exports)
    descriptors[key] = {
      value: wrapped,
      enumerable: true,
      configurable: true,
      writable: true,
    }
    return Object.create(Object.getPrototypeOf(exports), descriptors)
  }
})

// degraded mode skips the router, so events would go missing on a bad connection
patchThunk(
  'handleMessageImmediatelyWithoutPreprocessing',
  (original) =>
    (...args: any[]) => {
      const event = args[0] as RtmEvent | undefined
      emit(event?.type, event)
      return original(...args)
    }
)

/** listen for a websocket event by type, or `*` for all of them */
export function onRtmEvent(type: string, listener: RtmListener): () => void {
  let set = listeners.get(type)
  if (!set) {
    set = new Set()
    listeners.set(type, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(type)
  }
}

export const rtmPromise = (async () => {
  return { on: onRtmEvent }
})()

export type RtmAPI = Awaited<typeof rtmPromise>
