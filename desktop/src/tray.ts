// Taut Desktop Tray: wraps the Tray Slack makes so a plugin can hide it or take over its clicks

import { EventEmitter } from 'node:events'
import { ipcMain, type WebContents } from 'electron'
import type { TautTrayEvent, TautTrayState } from '../../shared/TautBridge'

const TRAY_EVENTS: TautTrayEvent[] = [
  'click',
  'right-click',
  'middle-click',
  'double-click',
]

// calls that set what the icon shows, kept so a tray that was hidden comes back looking the same
const REPLAYED = [
  'setImage',
  'setPressedImage',
  'setToolTip',
  'setTitle',
  'setContextMenu',
  'setIgnoreDoubleClickEvents',
] as const

const EMITTER_METHODS = new Set([
  'on',
  'once',
  'off',
  'addListener',
  'removeListener',
  'removeAllListeners',
  'prependListener',
  'listeners',
  'listenerCount',
  'eventNames',
  'emit',
])

type ManagedTray = {
  show(): void
  hide(): void
  present(): boolean
}

const trays = new Set<ManagedTray>()
let hidden = false
const intercepted = new Set<TautTrayEvent>()
/** the window that asked for the state above, it gets the intercepted events and its reload undoes them */
let owner: WebContents | null = null

function reset() {
  owner = null
  intercepted.clear()
  if (!hidden) return
  hidden = false
  for (const tray of trays) tray.show()
}

function claim(sender: WebContents) {
  if (owner === sender) return
  if (owner && !owner.isDestroyed()) reset()
  owner = sender
  // a reload or crash doesn't run the plugin's cleanup, so the page going away undoes what it asked for
  const release = () => owner === sender && reset()
  sender.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) release()
  })
  sender.once('render-process-gone', release)
  sender.once('destroyed', release)
}

function forward(event: TautTrayEvent) {
  if (!intercepted.has(event) || !owner || owner.isDestroyed()) return false
  owner.send('taut:tray-event', event)
  return true
}

/** the Tray constructor Slack gets, its trays behave like the real one but can be hidden and have clicks taken */
export function wrapTray(RealTray: typeof Electron.Tray): typeof Electron.Tray {
  return new Proxy(RealTray, {
    construct(_Target, args: ConstructorParameters<typeof Electron.Tray>) {
      return createManagedTray(RealTray, args)
    },
  })
}

function createManagedTray(
  RealTray: typeof Electron.Tray,
  ctorArgs: ConstructorParameters<typeof Electron.Tray>
) {
  const bus = new EventEmitter()
  const last = new Map<string, unknown[]>()
  let real: Electron.Tray | null = null
  let destroyed = false

  const attach = () => {
    // a tray made again takes the image the last one showed
    const image = last.get('setImage')?.[0] ?? ctorArgs[0]
    const tray = new RealTray(image as Electron.NativeImage, ctorArgs[1])
    real = tray
    for (const method of REPLAYED) {
      const args = last.get(method)
      if (args) (tray[method] as (...a: unknown[]) => void)(...args)
    }
    for (const event of TRAY_EVENTS) {
      tray.on(event as 'click', (...eventArgs: unknown[]) => {
        if (!forward(event)) bus.emit(event, ...eventArgs)
      })
    }
    // everything else Slack might listen for (mouse-enter, drop-files, ...) goes straight through
    const origEmit = tray.emit.bind(tray)
    tray.emit = ((event: string, ...rest: unknown[]) => {
      if (TRAY_EVENTS.includes(event as TautTrayEvent))
        return origEmit(event, ...rest)
      return bus.emit(event, ...rest) || origEmit(event, ...rest)
    }) as typeof tray.emit
  }

  const detach = () => {
    const old = real
    real = null
    if (old && !old.isDestroyed()) old.destroy()
  }

  const managed: ManagedTray = {
    present: () => !destroyed,
    show() {
      if (!destroyed && !real) attach()
    },
    hide() {
      detach()
    },
  }
  trays.add(managed)
  if (!hidden) attach()

  const managedProxy: Electron.Tray = new Proxy({} as Electron.Tray, {
    get(_, prop: string | symbol) {
      if (typeof prop === 'symbol') return undefined
      if (EMITTER_METHODS.has(prop)) {
        const fn = (
          bus as unknown as Record<string, (...a: unknown[]) => unknown>
        )[prop]
        return (...a: unknown[]) => {
          const result = fn.apply(bus, a)
          return result === bus ? managedProxy : result
        }
      }
      if (prop === 'destroy')
        return () => {
          if (destroyed) return
          destroyed = true
          trays.delete(managed)
          detach()
          bus.removeAllListeners()
        }
      if (prop === 'isDestroyed') return () => destroyed
      if ((REPLAYED as readonly string[]).includes(prop))
        return (...a: unknown[]) => {
          last.set(prop, a)
          return real ? (real as any)[prop](...a) : undefined
        }
      // while hidden there is nothing to ask or show
      if (prop === 'getBounds')
        return () => real?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 }
      if (prop === 'getTitle')
        return () => (last.get('setTitle')?.[0] as string) ?? ''
      const value = real ? (real as any)[prop] : undefined
      if (typeof value === 'function') return value.bind(real)
      return value ?? (() => undefined)
    },
  })
  return managedProxy
}

/** `state` and the controls behind `TautBridge.tray`, the window that calls them owns the result */
export function setupTray() {
  ipcMain.handle(
    'taut:tray-state',
    (): TautTrayState => ({
      present: [...trays].some((tray) => tray.present()),
      hidden,
    })
  )
  ipcMain.on('taut:tray-hidden', (event, hide: boolean) => {
    claim(event.sender)
    hidden = !!hide
    for (const tray of trays) hidden ? tray.hide() : tray.show()
  })
  ipcMain.on('taut:tray-intercept', (event, events: TautTrayEvent[]) => {
    claim(event.sender)
    intercepted.clear()
    for (const name of events)
      if (TRAY_EVENTS.includes(name)) intercepted.add(name)
  })
}
