// Taut App Entrypoint
// Checks loader preconditions then bootstraps

import { bootstrap } from './bootstrap'
import { normalizeBridge } from './bridgeCompat'

export const MIN_BRIDGE_VERSION = 2

function main() {
  const global = globalThis as any
  const bridge = global.TautBridge

  // Precondition 1: TautBridge must be present with loader metadata
  if (!bridge?.loader || typeof bridge?.bridgeVersion !== 'number') {
    alert(
      '[Taut] Failed to initialize: no TautBridge found. Slack will load normally.'
    )
    return
  }

  // Precondition 2: CSP must be gone (loader must have removed the meta tag)
  let cspOk = false
  try {
    // biome-ignore lint/complexity/noCommaOperator: indirect eval is used intentionally
    // biome-ignore lint/security/noGlobalEval: needed to check if eval is blocked by CSP
    ;(0, eval)('1')
    cspOk = true
  } catch {}
  if (!cspOk) {
    alert(
      '[Taut] Failed to initialize: Content Security Policy is still active. Slack will load normally.'
    )
    return
  }

  // Precondition 3: Slack webpack must not have loaded yet (loader injected us too late)
  if (global.webpackChunkwebapp) {
    alert(
      '[Taut] Failed to initialize: Slack loaded before Taut. Slack will load normally.'
    )
    return
  }

  // Precondition 4: loader bridge API must meet minimum version requirement
  if (bridge.bridgeVersion < MIN_BRIDGE_VERSION) {
    bridge.warnOutdated()
    return
  }

  const normalizedBridge = normalizeBridge(bridge)
  bootstrap(normalizedBridge)
}

main()
