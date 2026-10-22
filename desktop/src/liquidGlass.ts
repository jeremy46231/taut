// Taut Desktop Liquid Glass: hosts the native NSGlassEffectViews a plugin asks for under or over a see-through window

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, ipcMain } from 'electron'
import { getLiquidGlass, savePrefs } from './prefs.js'

export type GlassShape = {
  id: number
  x: number
  y: number
  w: number
  h: number
  /** flat ops in the shape's own coordinates, see liquid-glass/glass.mm */
  path?: number[]
  tint?: [number, number, number, number]
  clear?: boolean
  /** over the page instead of under it */
  above?: boolean
  /** a custom outline, drawn on its own instead of inside the merging container */
  shaped?: boolean
  /** corner radius of a plain rounded rectangle */
  radius?: number
  /** moves with no animation, for pieces the page already eases itself */
  snap?: boolean
}

export type GlassOptions = {
  /** glass closer than this merges, in points */
  spacing?: number
  /** fade and glide pieces in and out */
  animate?: boolean
  /** only add or move the shapes sent, leave the others */
  partial?: boolean
}

export type GlassState = {
  /** macOS with the native module loaded */
  supported: boolean
  /** the windows were made see-through at launch, which only the preference does */
  ready: boolean
}

type Native = {
  setShapes: (
    handle: Buffer,
    shapes: GlassShape[],
    options: GlassOptions
  ) => string
  prepareWindow: (handle: Buffer) => void
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let native: Native | null | undefined
function loadNative(): Native | null {
  if (native !== undefined) return native
  native = null
  if (process.platform !== 'darwin') return native
  const file = `glass-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}.node`
  // a packaged app keeps native modules outside the asar archive
  const dir = __dirname.replace('app.asar', 'app.asar.unpacked')
  try {
    const mod = { exports: {} as unknown }
    process.dlopen(mod, path.join(dir, file))
    native = mod.exports as Native
  } catch (err) {
    console.warn('[Taut] Liquid Glass unavailable:', (err as Error).message)
  }
  return native
}

let launchedWithGlass: boolean | undefined

/**
 * whether windows are created see-through, which can't change once a window exists, so the preference is
 * read once at the first window and a change made while running only applies from the next launch
 */
export function glassWindows(): boolean {
  launchedWithGlass ??= process.platform === 'darwin' && getLiquidGlass()
  return launchedWithGlass
}

const prepared = new WeakSet<BrowserWindow>()

/** Chromium paints its own backdrop under the page and puts it back on navigation, so the override is reapplied */
function keepPageTransparent(win: BrowserWindow) {
  const { webContents } = win
  const apply = () => {
    if (webContents.isDestroyed()) return
    try {
      if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3')
      webContents.debugger
        .sendCommand('Emulation.setDefaultBackgroundColorOverride', {
          color: { r: 0, g: 0, b: 0, a: 0 },
        })
        .catch(() => {})
    } catch (err) {
      console.warn(
        '[Taut] Liquid Glass transparency failed:',
        (err as Error).message
      )
    }
  }
  apply()
  for (const event of [
    'did-finish-load',
    'did-navigate',
    'did-navigate-in-page',
    'dom-ready',
  ] as const) {
    webContents.on(event as 'did-finish-load', apply)
  }
  win.on('focus', apply)
  win.on('resize', apply)
}

export function setupLiquidGlass() {
  ipcMain.handle(
    'taut:glass-state',
    (): GlassState => ({
      supported: loadNative() !== null,
      ready: glassWindows(),
    })
  )

  // the windows that already exist can't become see-through, so this applies from the next launch
  ipcMain.handle('taut:glass-enable', async (_, on: boolean) => {
    await savePrefs({ liquidGlass: on })
    return glassWindows() !== on
  })

  ipcMain.on('taut:glass-chrome', (event, hide: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed() && process.platform === 'darwin') {
      win.setWindowButtonVisibility(!hide)
    }
  })

  ipcMain.on(
    'taut:glass-set',
    (event, shapes: GlassShape[] | null, options?: GlassOptions) => {
      const lib = loadNative()
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!lib || !win || win.isDestroyed() || !glassWindows()) return
      try {
        const handle = win.getNativeWindowHandle()
        if (!prepared.has(win)) {
          prepared.add(win)
          lib.prepareWindow(handle)
          win.setBackgroundColor('#00000000')
          keepPageTransparent(win)
          win.once('closed', () => prepared.delete(win))
        }
        lib.setShapes(handle, shapes ?? [], options ?? {})
      } catch (err) {
        console.warn('[Taut] Liquid Glass failed:', (err as Error).message)
      }
    }
  )
}
