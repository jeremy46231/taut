// A silly idea that turns Slack into macOS Liquid Glass, you should probably never use it

import { type GlassShape, opt, TautPlugin } from '$taut'

type Color = [number, number, number, number]

/** always glass, even with no background of their own */
const SURFACES = [
  '.p-tab_rail',
  '.p-view_contents--sidebar',
  '.p-view_contents--primary',
  '.p-ia4_top_nav',
  '.c-menu',
  '.c-popover__content',
  '.ReactModal__Content',
  '.c-toast',
]

/** the big panes stay under the page, frosting what is behind the window, the rest sits over the page */
const BASE = [
  '.p-tab_rail',
  '.p-view_contents--sidebar',
  '.p-view_contents--primary',
  '.p-ia4_top_nav',
]

/** the surfaces that must exist before the page's layout counts as mounted */
const CORE = [
  '.p-tab_rail',
  '.p-view_contents--sidebar',
  '.p-view_contents--primary',
]

/** opaque layers that would hide the glass behind them */
const COVERS = [
  '.c-scrollbar__hider',
  '.p-theme_background',
  '.p-view_header--primary-background',
  '.p-threads_view',
  '.p-activity_ia4_page__tab_menu',
  '.p-client_workspace_wrapper',
  '.p-client_container',
  '.p-client_workspace',
]

const OFF = 'data-taut-liquid-glass-off'
const ON = 'data-taut-liquid-glass'
const MARK = 'data-taut-liquid-glass-element'
/** has a background or shadow that is cleared without becoming glass, like big message cards and scrollbar thumbs */
const CLEAR = 'data-taut-liquid-glass-clear'

/** an element with a background at least this opaque becomes glass when `everything` is on */
const MIN_ALPHA = 0.03
const MIN_SIZE = 12
const MAX_ELEMENTS = 160

/** anything bigger than this stays under the page, big sheets of blur over the content are unusable */
const MAX_ABOVE_AREA = 40000

const FIELD = 'input, textarea, [contenteditable], [role="textbox"]'

function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector)
  } catch {
    return false
  }
}

const CURSOR_ID = 999999
/** the size of the real macOS pointer, in points */
const ARROW_W = 14
const ARROW_H = 22.5

/**
 * A closed shape as 8 cubic segments, 25 numbers: the start point then 8 times (control, control, end),
 * so two different shapes can be blended point by point
 */
type Outline = number[]

const line = (x0: number, y0: number, x1: number, y1: number): number[] => [
  x0 + (x1 - x0) / 3,
  y0 + (y1 - y0) / 3,
  x0 + ((x1 - x0) * 2) / 3,
  y0 + ((y1 - y0) * 2) / 3,
  x1,
  y1,
]

/** the classic pointer arrow, tip at the top left, stretched to w by h */
function arrowPoints(w: number, h: number): Outline {
  const sx = w / 14
  const sy = h / 22.5
  const v: [number, number][] = [
    [0, 0],
    [0, 19],
    [4.6, 15],
    [7.6, 22.5],
    [11, 21],
    [8, 13.7],
    [14, 13.7],
    [7, 6.85],
  ].map(([x, y]) => [x * sx, y * sy])
  const out: Outline = [v[0][0], v[0][1]]
  for (let i = 0; i < 8; i++) {
    const a = v[i]
    const b = v[(i + 1) % 8]
    out.push(...line(a[0], a[1], b[0], b[1]))
  }
  return out
}

/** a rounded rectangle in the same 8 segment form, counterclockwise from the left edge like the arrow */
function rectPoints(w: number, h: number, radius: number): Outline {
  const r = Math.min(radius, w / 2, h / 2)
  const k = r * (1 - KAPPA)
  const out: Outline = [0, r]
  out.push(...line(0, r, 0, h - r))
  out.push(0, h - k, k, h, r, h)
  out.push(...line(r, h, w - r, h))
  out.push(w - k, h, w, h - k, w, h - r)
  out.push(...line(w, h - r, w, r))
  out.push(w, k, w - k, 0, w - r, 0)
  out.push(...line(w - r, 0, r, 0))
  out.push(k, 0, 0, k, 0, r)
  return out
}

/** `from` to `to` by `t`, as native glass path ops */
function morphPath(from: Outline, to: Outline, t: number): number[] {
  const p = from.map((v, i) => v + (to[i] - v) * t)
  const out: number[] = [0, p[0], p[1]]
  for (let i = 2; i < p.length; i += 6) {
    out.push(2, p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5])
  }
  out.push(3)
  return out
}

/** a quarter circle as a cubic curve */
const KAPPA = 0.5522847498

/** `top` drawn over `under` */
function over(top: Color, under: Color): Color {
  const a = top[3] + under[3] * (1 - top[3])
  const mix = (i: number) =>
    (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a
  return [mix(0), mix(1), mix(2), a]
}

function parseColor(value: string): Color | null {
  const m = value.match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const parts = m[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number)
  if (parts.length < 3 || parts.some(Number.isNaN)) return null
  return [parts[0], parts[1], parts[2], parts[3] ?? 1]
}

/** a rounded rectangle with a radius per corner (tl, tr, br, bl) as native glass path ops */
function roundedRect(w: number, h: number, r: number[]): number[] {
  const [tl, tr, br, bl] = r.map((v) => Math.min(v, w / 2, h / 2))
  const k = 1 - KAPPA
  // biome-ignore format: one segment per line
  return [
    0, tl, 0,
    1, w - tr, 0,
    2, w - tr * k, 0, w, tr * k, w, tr,
    1, w, h - br,
    2, w, h - br * k, w - br * k, h, w - br, h,
    1, bl, h,
    2, bl * k, h, 0, h - bl * k, 0, h - bl,
    1, 0, tl,
    2, 0, tl * k, tl * k, 0, tl, 0,
    3,
  ]
}

/** an SVG arc as cubic curves, from the SVG spec's endpoint to center conversion */
function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  degrees: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number
): number[][] {
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (!rx || !ry || (x1 === x2 && y1 === y2)) return [[x1, y1, x2, y2, x2, y2]]
  const phi = (degrees * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const sign = largeArc === sweep ? -1 : 1
  const coef = sign * Math.sqrt(Math.max(0, num / den))
  const cxp = (coef * rx * y1p) / ry
  const cyp = (-coef * ry * x1p) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return a
  }
  const start = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let delta = angle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry
  )
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  if (sweep && delta < 0) delta += 2 * Math.PI
  const segments = Math.ceil(Math.abs(delta) / (Math.PI / 2))
  const step = delta / segments
  const t = (4 / 3) * Math.tan(step / 4)
  const out: number[][] = []
  const point = (a: number, ox: number, oy: number) => {
    const px = rx * (Math.cos(a) + ox * Math.sin(a))
    const py = ry * (Math.sin(a) - oy * Math.cos(a))
    return [cos * px - sin * py + cx, sin * px + cos * py + cy]
  }
  for (let i = 0; i < segments; i++) {
    const a1 = start + i * step
    const a2 = a1 + step
    const [c1x, c1y] = point(a1, -t, -t)
    const [c2x, c2y] = point(a2, t, t)
    const [ex, ey] = point(a2, 0, 0)
    out.push([c1x, c1y, c2x, c2y, ex, ey])
  }
  // land exactly on the endpoint
  out[out.length - 1][4] = x2
  out[out.length - 1][5] = y2
  return out
}

/**
 * An SVG path (`d`) as native glass ops. The path is drawn in a 0 to 100 box and stretched
 * to the element, like an SVG with `viewBox="0 0 100 100" preserveAspectRatio="none"`.
 * Supports M L H V C S Q T A Z, absolute and relative.
 */
function svgPath(d: string, w: number, h: number): number[] | null {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g)
  if (!tokens) return null
  const sx = w / 100
  const sy = h / 100
  const out: number[] = []
  let i = 0
  let cmd = ''
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let lastCx = 0
  let lastCy = 0
  let lastKind = ''
  const num = () => Number(tokens[i++])
  const move = (px: number, py: number) => out.push(0, px * sx, py * sy)
  const line = (px: number, py: number) => out.push(1, px * sx, py * sy)
  const cubic = (
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    px: number,
    py: number
  ) => {
    out.push(2, c1x * sx, c1y * sy, c2x * sx, c2y * sy, px * sx, py * sy)
    lastCx = c2x
    lastCy = c2y
  }
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++]
    else if (cmd === 'M') cmd = 'L'
    else if (cmd === 'm') cmd = 'l'
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    const upper = cmd.toUpperCase()
    let kind = upper
    if (upper === 'M') {
      x = num() + ox
      y = num() + oy
      startX = x
      startY = y
      move(x, y)
    } else if (upper === 'L') {
      x = num() + ox
      y = num() + oy
      line(x, y)
    } else if (upper === 'H') {
      x = num() + ox
      line(x, y)
    } else if (upper === 'V') {
      y = num() + oy
      line(x, y)
    } else if (upper === 'C') {
      const c1x = num() + ox
      const c1y = num() + oy
      const c2x = num() + ox
      const c2y = num() + oy
      x = num() + ox
      y = num() + oy
      cubic(c1x, c1y, c2x, c2y, x, y)
    } else if (upper === 'S') {
      const smooth = lastKind === 'C' || lastKind === 'S'
      const c1x = smooth ? 2 * x - lastCx : x
      const c1y = smooth ? 2 * y - lastCy : y
      const c2x = num() + ox
      const c2y = num() + oy
      x = num() + ox
      y = num() + oy
      cubic(c1x, c1y, c2x, c2y, x, y)
    } else if (upper === 'Q' || upper === 'T') {
      let qx: number
      let qy: number
      if (upper === 'Q') {
        qx = num() + ox
        qy = num() + oy
      } else {
        const smooth = lastKind === 'Q' || lastKind === 'T'
        qx = smooth ? 2 * x - lastCx : x
        qy = smooth ? 2 * y - lastCy : y
      }
      const px = num() + ox
      const py = num() + oy
      cubic(
        x + (2 / 3) * (qx - x),
        y + (2 / 3) * (qy - y),
        px + (2 / 3) * (qx - px),
        py + (2 / 3) * (qy - py),
        px,
        py
      )
      // a quadratic's own control point is what a following T mirrors
      lastCx = qx
      lastCy = qy
      x = px
      y = py
    } else if (upper === 'A') {
      const rx = num()
      const ry = num()
      const rotation = num()
      const large = num() !== 0
      const sweep = num() !== 0
      const px = num() + ox
      const py = num() + oy
      for (const seg of arcToCubics(
        x,
        y,
        rx,
        ry,
        rotation,
        large,
        sweep,
        px,
        py
      )) {
        cubic(seg[0], seg[1], seg[2], seg[3], seg[4], seg[5])
      }
      x = px
      y = py
      kind = 'A'
    } else if (upper === 'Z') {
      out.push(3)
      x = startX
      y = startY
    } else {
      return null
    }
    lastKind = kind
  }
  return out.length ? out : null
}

export default class LiquidAss extends TautPlugin<typeof LiquidAss> {
  static readonly id = 'LiquidAss'
  static readonly pluginName = 'Liquid Ass'
  static readonly description =
    'A silly idea that turns Slack into macOS Liquid Glass, you should probably never use it'
  static readonly authors = ['izie'] as const
  static readonly category = 'fun'
  static readonly defaultConfig = {
    enabled: false,
    opacity: opt.number(
      0.15,
      "How opaque the glass background is, from 0 (clear glass) to 1 (the element's own solid color)",
      { min: 0, max: 1 }
    ),
    tint: opt(
      true,
      'Color the glass with the color each element normally has, off makes it plain glass'
    ),
    cursor: opt(
      true,
      'Include a glass mouse cursor that follows the pointer and morphs into what you hover'
    ),
    hideButtons: opt(
      true,
      'Hide the window close, minimize and zoom buttons (Cmd+W and Cmd+M still work)'
    ),
    everything: opt(
      true,
      'Make every element with a background glass, not only the main panes'
    ),
    clear: opt(true, 'Use the clearer, more transparent glass style'),
    panes: opt(
      false,
      'Also make the big panes (sidebar, rail, main view, top bar) glass, off leaves only the elements on them'
    ),
    refract: opt(
      false,
      'Put everything but the big panes over the page, so the glass bends and highlights the Slack content under it'
    ),
    aboveSelectors: opt.list(
      [],
      'Extra CSS selectors to put over the page. Glass over text blurs the text'
    ),
    merge: opt.number(
      24,
      'Glass closer together than this many pixels flows into one piece',
      { min: 0, max: 120 }
    ),
    customShapes: opt(
      {} as Record<string, string>,
      'CSS selector to SVG path, drawn in a 0 to 100 box and stretched to the element. An element can also set --taut-glass-path in CSS'
    ),
  }

  private cursorFrame = 0
  private pointer = { x: -200, y: -200, inside: false }
  private blob = {
    x: -200,
    y: -200,
    w: ARROW_W,
    h: ARROW_H,
    r: 0,
    m: 0,
    time: 0,
  }
  private lastHover: Element | null = null
  private ids = new Map<Element, number>()
  private colors = new Map<Element, Color | null>()
  private checked = new WeakSet<Element>()
  private pending = new Set<Element>()
  /** elements whose class changed, looked at again by themselves */
  private reclassify = new Set<Element>()
  private cleared = new Set<Element>()
  private nextId = 1
  private frame = 0
  private scanTimer = 0
  private scrollTimer = 0
  private active = false
  private restartNotice = 0
  private scrolling = false
  private resizeObserver?: ResizeObserver
  private disposers: (() => void)[] = []

  async start(): Promise<void> {
    const state = await this.api.glass.state()
    if (!state.supported) {
      this.log('native glass needs the Taut desktop app on macOS 26 or later')
      return
    }
    // windows can only be made see-through as they are created, so the first time it takes a restart
    if (!state.ready) {
      if (await this.api.glass.enable(true)) {
        // Slack's UI isn't up yet this early in boot, so the dialog waits for it
        this.restartNotice = window.setTimeout(() => {
          this.api.modal.alert({
            title: 'Restart Taut',
            body: 'Liquid Ass needs Taut restarted once to make its windows see-through.',
          })
        }, 6000)
      }
      return
    }
    this.active = true

    if (this.config.hideButtons) this.api.glass.hideWindowButtons(true)

    const seeds = SURFACES.join(', ')
    this.api.setStyle(
      `
      html[${ON}]:not([${OFF}]),
      html[${ON}]:not([${OFF}]) body,
      html[${ON}]:not([${OFF}]) :is(${COVERS.join(', ')}),
      html[${ON}]:not([${OFF}]) :is([${MARK}], [${CLEAR}]) {
        background: transparent !important;
        background-image: none !important;
        backdrop-filter: none !important;
        box-shadow: none !important;
      }
      ${this.config.cursor ? `html[${ON}], html[${ON}] * { cursor: none !important; }` : ''}
      html[${ON}]:not([${OFF}]) :is(${seeds}) {
        background: transparent !important;
        backdrop-filter: none !important;
        box-shadow: none !important;
      }
      `,
      'glass'
    )
    document.documentElement.setAttribute(ON, '')

    this.resizeObserver = new ResizeObserver(() => this.schedule())

    // new nodes are looked at once each, so this stays cheap while Slack renders
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element) this.pending.add(node)
        }
      }
      this.queueScan()
    })
    mutations.observe(document.body, { childList: true, subtree: true })

    // a selected row or a hover highlight gets its background from a class added later
    const classes = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target instanceof Element) this.reclassify.add(record.target)
      }
      this.queueScan()
    })
    classes.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
      subtree: true,
    })

    // the theme lives on these two, so a change re-reads the colors
    const themes = new MutationObserver(() => {
      this.colors.clear()
      this.schedule()
    })
    themes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    })
    themes.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    })

    const onResize = () => this.schedule()
    const onScroll = () => {
      this.scrolling = true
      clearTimeout(this.scrollTimer)
      this.scrollTimer = window.setTimeout(() => {
        this.scrolling = false
        this.schedule()
      }, 140)
      this.schedule()
    }
    const onCursor = (event: MouseEvent) => {
      this.pointer = { x: event.clientX, y: event.clientY, inside: true }
      this.runCursor()
    }
    const onLeave = () => {
      this.pointer.inside = false
      this.runCursor()
    }
    if (this.config.cursor) {
      window.addEventListener('mousemove', onCursor, true)
      document.addEventListener('mouseleave', onLeave)
    }
    window.addEventListener('resize', onResize)
    document.addEventListener('scroll', onScroll, {
      capture: true,
      passive: true,
    })

    this.disposers.push(
      () => mutations.disconnect(),
      () => classes.disconnect(),
      () => themes.disconnect(),
      () => window.removeEventListener('mousemove', onCursor, true),
      () => document.removeEventListener('mouseleave', onLeave),
      () => window.removeEventListener('resize', onResize),
      () => document.removeEventListener('scroll', onScroll, true)
    )
    this.pending.add(document.body)
    this.queueScan()
  }

  stop(): void {
    clearTimeout(this.restartNotice)
    cancelAnimationFrame(this.frame)
    clearTimeout(this.scanTimer)
    clearTimeout(this.scrollTimer)
    for (const dispose of this.disposers.splice(0)) dispose()
    this.resizeObserver?.disconnect()
    for (const el of this.ids.keys()) el.removeAttribute(MARK)
    for (const el of this.cleared) el.removeAttribute(CLEAR)
    this.cleared.clear()
    this.reclassify.clear()
    this.ids.clear()
    this.colors.clear()
    this.pending.clear()
    document.documentElement.removeAttribute(ON)
    cancelAnimationFrame(this.cursorFrame)
    this.cursorFrame = 0
    // the glass and the window buttons are put back by the scoped API when the plugin stops
    this.active = false
  }

  /** what the blob turns into when the pointer is over it */
  private static readonly INTERACTIVE =
    'button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="option"], input, textarea, select, summary, [tabindex]:not([tabindex="-1"]), .p-channel_sidebar__link, .p-channel_sidebar__channel'

  /** where the blob wants to be: an arrow at the pointer, or the hovered control, leaning toward the pointer */
  private blobTarget() {
    const { x, y, inside } = this.pointer
    const hovered = inside
      ? document.elementFromPoint(x, y)?.closest(LiquidAss.INTERACTIVE)
      : null
    this.lastHover = hovered ?? null
    if (!inside) {
      return { x: -200, y: -200, w: ARROW_W, h: ARROW_H, r: 0, m: 0 }
    }
    if (hovered) {
      const rect = hovered.getBoundingClientRect()
      if (rect.width * rect.height < MAX_ABOVE_AREA * 4) {
        const pad = 5
        const w = rect.width + pad * 2
        const h = rect.height + pad * 2
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        // it drifts a little toward the pointer, so it feels pulled along rather than snapped
        const lean = 0.18
        const radius =
          Number.parseFloat(getComputedStyle(hovered).borderTopLeftRadius) || 8
        return {
          x: cx + (x - cx) * lean - w / 2,
          y: cy + (y - cy) * lean - h / 2,
          w,
          h,
          r: Math.min(radius + pad, w / 2, h / 2),
          m: 1,
        }
      }
    }
    // the arrow's tip is its top left corner, so that is what sits on the pointer
    return { x, y, w: ARROW_W, h: ARROW_H, r: 0, m: 0 }
  }

  private runCursor() {
    if (this.cursorFrame || !this.active) return
    const step = (now: number) => {
      this.cursorFrame = 0
      if (!this.active) return
      const target = this.blobTarget()
      const blob = this.blob
      const dt = Math.min(0.05, blob.time ? (now - blob.time) / 1000 : 0.016)
      blob.time = now
      // exponential easing, so it glides and settles without overshoot
      const k = 1 - Math.exp(-dt * 16)
      // the arrow follows the pointer tightly and only the morph into a control is slow
      const follow =
        target.m === 0 && blob.m < 0.05 ? 1 - Math.exp(-dt * 40) : k
      blob.x += (target.x - blob.x) * follow
      blob.y += (target.y - blob.y) * follow
      blob.w += (target.w - blob.w) * k
      blob.h += (target.h - blob.h) * k
      blob.r += (target.r - blob.r) * k
      blob.m += (target.m - blob.m) * k
      this.api.glass.set([this.cursorShape()], {
        partial: true,
        animate: false,
      })
      const settled =
        Math.abs(target.x - blob.x) < 0.4 &&
        Math.abs(target.y - blob.y) < 0.4 &&
        Math.abs(target.w - blob.w) < 0.4 &&
        Math.abs(target.h - blob.h) < 0.4 &&
        Math.abs(target.m - blob.m) < 0.01
      if (settled) blob.time = 0
      else this.cursorFrame = requestAnimationFrame(step)
    }
    this.cursorFrame = requestAnimationFrame(step)
  }

  private cursorShape(): GlassShape {
    const { x, y, r, m } = this.blob
    const w = Math.max(this.blob.w, 4)
    const h = Math.max(this.blob.h, 4)
    return {
      id: CURSOR_ID,
      x,
      y,
      w,
      h,
      path: morphPath(arrowPoints(w, h), rectPoints(w, h, r), m),
      // it is only a plain rounded rectangle once the morph has finished
      shaped: m < 0.98,
      radius: r,
      // strong as an arrow so a small shape shows, faint as a control so its text stays readable
      tint: [255, 255, 255, 0.4 - 0.32 * m],
      clear: true,
      // a lens over the page as an arrow, but under it once it has become a control, so the control's text stays sharp
      above: m < 0.5,
      snap: true,
    }
  }

  private queueScan() {
    if (this.scanTimer || !this.active) return
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = 0
      this.scan()
    }, 120)
  }

  /** finds the elements that should be glass among the nodes added since the last look */
  private scan() {
    const added: Element[] = []
    for (const root of this.pending) {
      if (!root.isConnected) continue
      for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
        if (this.checked.has(el)) continue
        this.checked.add(el)
        added.push(el)
      }
    }
    this.pending.clear()
    let rechecked = 0
    for (const el of this.reclassify) {
      if (rechecked++ > 300) break
      if (!el.isConnected || this.ids.has(el) || this.cleared.has(el)) continue
      added.push(el)
    }
    this.reclassify.clear()

    for (const el of this.ids.keys()) {
      if (el.isConnected) continue
      this.ids.delete(el)
      this.colors.delete(el)
    }

    const seeds = SURFACES.join(', ')
    for (const el of added) {
      if (this.ids.size >= MAX_ELEMENTS) break
      if (!this.config.panes && el.matches(BASE.join(', '))) continue
      if (this.ids.has(el) || this.cleared.has(el)) continue
      const kind = el.matches(seeds)
        ? 'glass'
        : this.config.everything
          ? this.classify(el)
          : null
      if (kind === 'glass') {
        this.ids.set(el, this.nextId++)
        this.resizeObserver?.observe(el)
      } else if (kind === 'clear') {
        this.cleared.add(el)
        el.setAttribute(CLEAR, '')
      }
    }
    this.sampleColors()
    this.mark()
    this.schedule()

    // Slack's layout mounts in stages, so look again until the core surfaces exist
    if (!CORE.every((selector) => document.querySelector(selector))) {
      this.pending.add(document.body)
      for (const el of Array.from(document.querySelectorAll(CORE.join(', ')))) {
        this.checked.delete(el)
      }
      this.queueScan()
    }
  }

  /**
   * Glass over the page blurs whatever is under it, including the element's own text, so only
   * small elements with no text of their own go over it, or ones the config names
   */
  private isAbove(el: Element): boolean {
    if (!this.config.refract || el.matches(BASE.join(', '))) return false
    const forced = this.config.aboveSelectors as string[]
    if (forced.some((selector) => safeMatches(el, selector))) return true
    const rect = el.getBoundingClientRect()
    if (rect.width * rect.height > MAX_ABOVE_AREA) return false
    // a field's placeholder isn't text content, but glass would smear it just the same
    if (el.matches(FIELD) || el.querySelector(FIELD)) return false
    return (el.textContent ?? '').trim() === ''
  }

  /** glass over the page keeps the element's own background, which is what it bends */
  private mark() {
    for (const el of this.ids.keys()) {
      if (this.isAbove(el)) {
        if (el.hasAttribute(MARK)) el.removeAttribute(MARK)
      } else if (!el.hasAttribute(MARK)) {
        el.setAttribute(MARK, '')
      }
    }
  }

  /**
   * Glass for an element with a background of a usable size. Ones that are too big (layout, long
   * message cards) or too small (scrollbar thumbs), and ones that only draw a shadow, are made
   * transparent instead, so nothing of the page's own is left painted behind the glass.
   */
  private classify(el: Element): 'glass' | 'clear' | null {
    if (el === document.body || el === document.documentElement) return null
    // hidden things (shortcut hints, closed menus) can still have a background, and as glass they would show
    const visible = el as Element & {
      checkVisibility?: (options?: object) => boolean
    }
    if (
      visible.checkVisibility &&
      !visible.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        opacityProperty: true,
        visibilityProperty: true,
      })
    ) {
      return null
    }
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    const color = parseColor(style.backgroundColor)
    if (color && color[3] >= MIN_ALPHA) {
      if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return 'clear'
      const layoutArea = window.innerWidth * window.innerHeight
      if (rect.width * rect.height > layoutArea * 0.2) return 'clear'
      return 'glass'
    }
    // an outer shadow is a dark halo behind the glass, an inner one is a focus or inset effect
    if (
      style.boxShadow !== 'none' &&
      !style.boxShadow.includes('inset') &&
      rect.width >= 8 &&
      rect.height >= 8
    ) {
      return 'clear'
    }
    return null
  }

  private schedule() {
    if (this.frame || !this.active) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.push()
    })
  }

  /** the colors the elements really show, read with the glass look off for this one synchronous pass */
  private sampleColors() {
    const root = document.documentElement
    const missing = [...this.ids.keys()].filter((el) => !this.colors.has(el))
    if (!missing.length) return
    for (const el of missing) el.removeAttribute(MARK)
    root.setAttribute(OFF, '')
    // the theme paints a gradient under everything, its first color is what the sidebar and rails sit on
    const themeImage = document.querySelector('.p-theme_background')
    const themeStop = themeImage
      ? parseColor(getComputedStyle(themeImage).backgroundImage)
      : null
    for (const el of missing) {
      const layers: Color[] = []
      for (let node: Element | null = el; node; node = node.parentElement) {
        const parsed = parseColor(getComputedStyle(node).backgroundColor)
        if (parsed && parsed[3] > 0) layers.push(parsed)
        if (parsed && parsed[3] >= 1) break
      }
      const solidBase = layers.length > 0 && layers[layers.length - 1][3] >= 1
      let color: Color | null = solidBase ? null : themeStop
      // outermost first, each layer drawn over what is under it
      for (const layer of layers.reverse()) {
        color = color ? over(layer, color) : layer
      }
      this.colors.set(el, color)
    }
    root.removeAttribute(OFF)
    this.mark()
  }

  /** the element's outline, and whether it is a custom one rather than the plain rounded rectangle it already was */
  private shapePath(
    el: Element,
    w: number,
    h: number,
    style: CSSStyleDeclaration
  ): { path: number[]; shaped: boolean; radius: number } {
    const custom = this.config.customShapes as Record<string, string>
    for (const [selector, d] of Object.entries(custom)) {
      if (!safeMatches(el, selector)) continue
      const path = svgPath(d, w, h)
      if (path) return { path, shaped: true, radius: 0 }
    }
    const fromCss = style.getPropertyValue('--taut-glass-path').trim()
    if (fromCss) {
      const path = svgPath(fromCss.replace(/^["']|["']$/g, ''), w, h)
      if (path) return { path, shaped: true, radius: 0 }
    }
    const radii = [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ].map((v) => Number.parseFloat(v) || 0)
    return { path: roundedRect(w, h, radii), shaped: false, radius: radii[0] }
  }

  private push() {
    if (!this.active) return
    this.mark()
    if (this.config.tint) this.sampleColors()
    const shapes: GlassShape[] = []
    for (const [el, id] of this.ids) {
      const rect = el.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) continue
      // off screen glass would only churn while scrolling
      if (
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth
      ) {
        continue
      }
      const style = getComputedStyle(el)
      const outline = this.shapePath(el, rect.width, rect.height, style)
      const shape: GlassShape = {
        id,
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
        path: outline.path,
        shaped: outline.shaped,
        radius: outline.radius,
        clear: this.config.clear,
      }
      const above = this.isAbove(el)
      if (above) {
        shape.above = true
        // text stays readable under the glass only in the clear style
        shape.clear = true
      }
      const color = this.config.tint ? this.colors.get(el) : null
      if (color) {
        const strength = above ? this.config.opacity / 2 : this.config.opacity
        shape.tint = [color[0], color[1], color[2], strength]
      }
      shapes.push(shape)
    }
    if (this.config.cursor) shapes.push(this.cursorShape())
    this.api.glass.set(shapes, {
      spacing: this.config.merge,
      animate: !this.scrolling,
    })
  }
}
