// Slack's menu bar or notification area icon, for plugins that hide it or take over its clicks

import type { TautTrayEvent, TautTrayState } from '../../shared/TautBridge'
import type { NormalizedBridge } from '../bridgeCompat'

export type { TautTrayEvent as TrayEvent, TautTrayState as TrayState }

/**
 * The icon Slack puts in the menu bar (macOS) or notification area, through the desktop app.
 * Elsewhere `state()` says there is none and the rest do nothing. What a plugin set is undone
 * when it stops, and when the page reloads.
 */
export function trayAPI(bridge: NormalizedBridge) {
  const tray = bridge.tray
  return {
    state: async (): Promise<TautTrayState> =>
      (await tray?.state()) ?? { present: false, hidden: false },
    /** removes the icon, or brings it back, Slack keeps updating it underneath */
    setHidden: (hidden: boolean) => tray?.setHidden(hidden),
    /**
     * Slack's own response to these events is skipped, and each one calls `onEvent` instead.
     * The list replaces the last one, an empty list gives the clicks back to Slack.
     */
    intercept: (events: TautTrayEvent[]) => tray?.intercept(events),
    /** calls back for intercepted events, right-click only gets here when intercepted */
    onEvent: (cb: (event: TautTrayEvent) => void): (() => void) =>
      tray?.onEvent(cb) ?? (() => {}),
  }
}

export type TrayAPI = ReturnType<typeof trayAPI>
