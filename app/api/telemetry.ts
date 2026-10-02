import type { BlobStore } from '../../shared/TautBridge'
import type { NormalizedBridge } from '../bridgeCompat'
import type { ConfigStore } from '../configStore'
import { getActiveTeam } from '../slack/localConfig'

declare const __TAUT_VERSION__: string
/** false in dev builds, see scripts/dev.ts */
declare const __TAUT_TELEMETRY__: boolean

const ENDPOINT = 'https://taut.jer.app/ping'
const CHECK_INTERVAL = 60 * 60 * 1000

export class Telemetry {
  private readonly store: BlobStore

  constructor(
    private readonly bridge: NormalizedBridge,
    private readonly configStore: ConfigStore
  ) {
    this.store = bridge.blobStore('telemetry')
  }

  start(): () => void {
    if (!__TAUT_TELEMETRY__) return () => {}
    this.pingIfDue()
    const timer = setInterval(() => this.pingIfDue(), CHECK_INTERVAL)
    return () => clearInterval(timer)
  }

  private async pingIfDue(): Promise<void> {
    if (this.configStore.getConfig().telemetry === false) return
    try {
      const team = getActiveTeam()
      if (!team?.id || !team.user_id) return
      const ping = JSON.stringify({
        day: new Date().toISOString().slice(0, 10),
        user: team.user_id,
        team: team.id,
        version: __TAUT_VERSION__,
        loaderVersion: this.bridge.loaderVersion,
      })
      if ((await this.store.read('lastPing')) === ping) return

      let install = await this.store.read('install')
      if (!install) {
        install = crypto.randomUUID()
        await this.store.write('install', install)
      }

      const response = await fetch(ENDPOINT, {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          install,
          user: team.user_id,
          team: team.id,
          version: __TAUT_VERSION__,
          loader: this.bridge.loader,
          loaderVersion: this.bridge.loaderVersion,
          embedded: this.bridge.embedded ?? null,
          os: navigator.platform,
        }),
      })
      if (response.ok) await this.store.write('lastPing', ping)
    } catch {
      // offline or the server is down or smth
    }
  }
}
