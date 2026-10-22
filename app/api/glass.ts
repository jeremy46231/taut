// Native macOS Liquid Glass, for plugins that put glass under or over the page

import type { NormalizedBridge } from '../bridgeCompat'

/** a piece of glass, positioned in the page's own pixels from the top left of the window */
export type GlassShape = {
  /** stable between updates, a shape sent with the same id moves instead of being made again */
  id: number
  x: number
  y: number
  w: number
  h: number
  /**
   * The outline in the shape's own coordinates, (0, 0) at its top left, as a flat list of ops:
   * `0 x y` move, `1 x y` line, `2 x1 y1 x2 y2 x y` cubic curve, `3` close
   */
  path?: number[]
  /** r, g, b (0 to 255) and alpha (0 to 1) */
  tint?: [number, number, number, number]
  /** the clearer, more transparent glass style */
  clear?: boolean
  /** over the page, bending and blurring what is under it, instead of under it, bending the desktop */
  above?: boolean
  /** a custom outline, drawn on its own instead of inside the container that merges close glass */
  shaped?: boolean
  /** corner radius of a plain rounded rectangle, used when `shaped` is false */
  radius?: number
  /** moves with no animation, for pieces you already ease yourself */
  snap?: boolean
}

export type GlassOptions = {
  /** glass closer than this many pixels flows into one piece */
  spacing?: number
  /** pieces fade and glide in and out, on by default */
  animate?: boolean
  /** only add or move the shapes sent and leave the others, for fast updates of one piece */
  partial?: boolean
}

export type GlassState = {
  /** macOS 26 or later in the desktop app, with the native module loaded */
  supported: boolean
  /** windows were made see-through at launch, see `enable` */
  ready: boolean
}

/**
 * Native Liquid Glass through the desktop app. Elsewhere `state()` says it isn't supported
 * and the rest do nothing. Everything a plugin has put up is removed when it stops.
 */
export function glassAPI(bridge: NormalizedBridge) {
  const glass = bridge.glass
  return {
    state: async (): Promise<GlassState> =>
      (await glass?.state()) ?? { supported: false, ready: false },
    /**
     * Windows have to be made see-through when they are created, so this is saved and applies from
     * the next launch. Resolves true when the app needs restarting for it to take effect.
     */
    enable: async (on: boolean): Promise<boolean> =>
      (await glass?.enable(on)) ?? false,
    /** hides or shows the window's close, minimize and zoom buttons */
    hideWindowButtons: (hide: boolean) => glass?.chrome(hide),
    /** replaces all of the glass, `null` or an empty list removes it */
    set: (shapes: GlassShape[] | null, options?: GlassOptions) =>
      glass?.set(shapes, options),
  }
}

export type GlassAPI = ReturnType<typeof glassAPI>
