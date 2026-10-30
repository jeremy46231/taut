// finer zoom steps than Slack's

import { app } from 'electron'
import { getZoom, savePrefs } from './prefs.js'

// percents, slack's steps plus the ones between them up to 125
const ZOOM_STEPS = [
  70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 125, 150, 175, 200,
]

const STEP_ITEMS: Record<string, 1 | -1> = {
  'menuitem-zoom-in': 1,
  'menuitem-zoom-in-numpad': 1,
  'menuitem-zoom-out': -1,
  'menuitem-zoom-out-numpad': -1,
}

const toLevel = (percent: number) => Math.log(percent / 100) / Math.log(1.2)

// slack's native level
let slackLevel: number | undefined
const zoomed = new Map<Electron.WebContents, (level: number) => void>()

export function hookZoom() {
  // slack sets webContents.zoomLevel, which calls this.setZoomLevel
  app.on('web-contents-created', (_event, webContents) => {
    const setLevel = webContents.setZoomLevel.bind(webContents)
    webContents.setZoomLevel = (level) => {
      if (!zoomed.has(webContents)) {
        zoomed.set(webContents, setLevel)
        webContents.once('destroyed', () => zoomed.delete(webContents))
      }
      // slack's zoom changed outside the menu (its preferences, or actual size)
      if (
        slackLevel !== undefined &&
        level !== slackLevel &&
        getZoom() !== undefined
      )
        savePrefs({ zoom: undefined })
      slackLevel = level
      const zoom = getZoom()
      setLevel(zoom === undefined ? level : toLevel(zoom))
    }
  })
}

function stepZoom(direction: 1 | -1) {
  if (!zoomed.size) return false
  const current = getZoom() ?? Math.round(100 * 1.2 ** (slackLevel ?? 0))
  const next =
    direction > 0
      ? ZOOM_STEPS.find((percent) => percent > current)
      : ZOOM_STEPS.filter((percent) => percent < current).pop()
  if (next === undefined) return true
  savePrefs({ zoom: next })
  for (const setLevel of zoomed.values()) setLevel(toLevel(next))
  return true
}

const rewired = new WeakSet<Electron.MenuItem>()

export function withTautZoom(menu: Electron.Menu) {
  for (const item of menu.items) {
    if (item.submenu) withTautZoom(item.submenu)
    const direction = STEP_ITEMS[item.id]
    const reset = item.id === 'menuitem-zoom-reset'
    if ((!direction && !reset) || rewired.has(item)) continue
    rewired.add(item)
    const original = item.click
    item.click = (...args: unknown[]) => {
      if (reset) savePrefs({ zoom: undefined })
      if (reset || !stepZoom(direction)) original(...args)
    }
  }
}
