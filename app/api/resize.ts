type Registration = {
  quietMs: number
  onHoldChange?: (holding: boolean) => void
}

const registrations = new Set<Registration>()

let timer: ReturnType<typeof setTimeout> | undefined
let replaying = false
let holding = false

const quietMs = () =>
  Math.max(...[...registrations].map((registration) => registration.quietMs))

// slack's resize observers fire every drag frame and entries are never re-sent, so keep the latest per target
type HeldObserver = {
  callback: ResizeObserverCallback
  observer: ResizeObserver
  entries: Map<Element, ResizeObserverEntry>
}

const heldObservers = new Set<HeldObserver>()

function releaseObservers() {
  const pending = [...heldObservers]
  heldObservers.clear()
  for (const held of pending) {
    if (!held.entries.size) continue
    const entries = [...held.entries.values()]
    held.entries.clear()
    try {
      held.callback.call(held.observer, entries, held.observer)
    } catch (error) {
      reportError(error)
    }
  }
}

function installResizeObserverHold() {
  const NativeResizeObserver = window.ResizeObserver
  if (typeof NativeResizeObserver !== 'function') return

  class HoldingResizeObserver extends NativeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      let held: HeldObserver | undefined
      super((entries, observer) => {
        if (!holding) return callback.call(observer, entries, observer)
        held ??= { callback, observer, entries: new Map() }
        for (const entry of entries) held.entries.set(entry.target, entry)
        heldObservers.add(held)
      })
      const disconnect = this.disconnect.bind(this)
      this.disconnect = () => {
        if (held) {
          heldObservers.delete(held)
          held.entries.clear()
        }
        disconnect()
      }
      const unobserve = this.unobserve.bind(this)
      this.unobserve = (target: Element) => {
        held?.entries.delete(target)
        unobserve(target)
      }
    }
  }
  Object.defineProperty(HoldingResizeObserver, 'name', {
    value: 'ResizeObserver',
  })
  window.ResizeObserver = HoldingResizeObserver
}

function notifyHoldChange(registration: Registration, next: boolean) {
  try {
    registration.onHoldChange?.(next)
  } catch (error) {
    reportError(error)
  }
}

function setHolding(next: boolean) {
  if (holding === next) return
  holding = next
  // after the flag flips, so a callback that resizes something is seen live
  if (!next) releaseObservers()
  for (const registration of registrations) {
    notifyHoldChange(registration, next)
  }
}

function flush() {
  timer = undefined
  setHolding(false)
  replaying = true
  try {
    window.dispatchEvent(new UIEvent('resize'))
  } finally {
    replaying = false
  }
}

function gate(event: Event) {
  if (!registrations.size || replaying) return
  setHolding(true)
  clearTimeout(timer)
  timer = setTimeout(flush, quietMs())
  // we're first, stop every other listener
  event.stopImmediatePropagation()
}

export function installResizeGate() {
  window.addEventListener('resize', gate, true)
  installResizeObserverHold()
}

export function deferResizeWork(options: {
  quietMs: number
  onHoldChange?: (holding: boolean) => void
}): () => void {
  const registration: Registration = {
    quietMs: options.quietMs,
    onHoldChange: options.onHoldChange,
  }
  registrations.add(registration)
  return () => {
    if (!registrations.delete(registration)) return
    notifyHoldChange(registration, false)
    if (registrations.size || !holding) return
    clearTimeout(timer)
    flush()
  }
}
