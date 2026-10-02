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
