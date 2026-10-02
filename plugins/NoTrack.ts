// Blocks Slack's built-in tracking and analytics requests

import { TautPlugin } from '$taut'

const TRACKING_PATTERNS = [
  '*://slackb.com/*',
  '*://*.slackb.com/*',
  '*://slack.com/beacon/*',
  '*://*.slack.com/beacon/*',
  '*://slack.com/clog/*',
  '*://*.slack.com/clog/*',
  '*://slack.com/api/*/beacon*',
  '*://*.slack.com/api/*/beacon*',
  '*://slack.com/api/*/clog*',
  '*://*.slack.com/api/*/clog*',
  '*://slack.com/api/*/science*',
  '*://*.slack.com/api/*/science*',
  '*://slack.com/api/*/metrics*',
  '*://*.slack.com/api/*/metrics*',
  '*://slack.com/api/*/typing*',
  '*://*.slack.com/api/*/typing*',
  '*://*.slack-edge.com/*/slack_beacon.*',
]

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

export default class NoTrack extends TautPlugin<typeof NoTrack> {
  static readonly id = 'NoTrack'
  static readonly pluginName = 'No Tracking'
  static readonly description =
    "Blocks Slack's built-in tracking and analytics requests"
  static readonly authors = ['rowan', 'jeremy'] as const
  static readonly category = 'privacy'
  static readonly defaultConfig = {
    enabled: true,
  }

  private matchers: RegExp[] = []
  private running = false
  private originalFetch: typeof window.fetch | null = null
  private originalXHROpen: typeof XMLHttpRequest.prototype.open | null = null
  private originalSendBeacon: typeof navigator.sendBeacon | null = null
  private sendBeaconWasOwn = false
  private restorePipelines: (() => void)[] = []

  private isBlocked(url: string): boolean {
    return this.matchers.some((re) => re.test(url))
  }

  private static urlString(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.href
    return (input as Request).url
  }

  private exportByName<T = any>(name: string): Promise<T> {
    return this.api.waitForExport<T>(this.api.byName(name))
  }

  private async stopTracing(): Promise<void> {
    const getGenericTracer =
      await this.exportByName<() => any>('getGenericTracer')
    if (!this.running) return
    const proto = Object.getPrototypeOf(getGenericTracer())
    const original = proto.shouldSample
    if (typeof original !== 'function') return
    proto.shouldSample = () => false
    this.restorePipelines.push(() => {
      proto.shouldSample = original
    })
  }

  private async stopMetrics(): Promise<void> {
    const [getGenericTelemeter, getNoopTelemeter] = await Promise.all([
      this.exportByName<() => any>('getGenericTelemeter'),
      this.exportByName<() => any>('getNoopTelemeter'),
    ])
    if (!this.running) return

    const real = Object.getPrototypeOf(getGenericTelemeter())
    const noop = Object.getPrototypeOf(getNoopTelemeter())
    for (const name of Object.getOwnPropertyNames(noop)) {
      if (name === 'constructor' || typeof noop[name] !== 'function') continue
      const original = real[name]
      real[name] = noop[name]
      this.restorePipelines.push(() => {
        real[name] = original
      })
    }
  }

  start(): void {
    this.running = true
    this.matchers = TRACKING_PATTERNS.map(globToRegex)

    this.originalFetch = window.fetch
    const originalFetch = this.originalFetch
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (this.isBlocked(NoTrack.urlString(input))) {
        return Promise.resolve(new Response('', { status: 200 }))
      }
      return originalFetch(input, init)
    }

    this.originalXHROpen = XMLHttpRequest.prototype.open
    const originalOpen = this.originalXHROpen
    const isBlocked = this.isBlocked.bind(this)
    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      ...rest: any[]
    ) {
      // still opened so setRequestHeader works, and a reused xhr gets its send back
      if (isBlocked(url.toString())) this.send = () => {}
      else delete (this as Partial<XMLHttpRequest>).send
      return Reflect.apply(originalOpen, this, [method, url, ...rest])
    }

    if (typeof navigator.sendBeacon === 'function') {
      this.originalSendBeacon = navigator.sendBeacon
      this.sendBeaconWasOwn = Object.hasOwn(navigator, 'sendBeacon')
      const originalSendBeacon = navigator.sendBeacon.bind(navigator)
      navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
        if (this.isBlocked(NoTrack.urlString(url))) return true
        return originalSendBeacon(url, data)
      }
    }

    const failed = (error: unknown) =>
      this.log('Could not stop a metrics pipeline', error)
    this.stopTracing().catch(failed)
    this.stopMetrics().catch(failed)

    this.log('Started, blocking', this.matchers.length, 'patterns')
  }

  stop(): void {
    this.running = false
    if (this.originalFetch) {
      window.fetch = this.originalFetch
      this.originalFetch = null
    }
    if (this.originalXHROpen) {
      XMLHttpRequest.prototype.open = this.originalXHROpen
      this.originalXHROpen = null
    }
    if (this.originalSendBeacon) {
      if (this.sendBeaconWasOwn) {
        navigator.sendBeacon = this.originalSendBeacon
      } else {
        delete (navigator as Partial<Navigator>).sendBeacon
      }
      this.originalSendBeacon = null
    }
    for (const restore of this.restorePipelines.reverse()) restore()
    this.restorePipelines = []
    this.matchers = []
    this.log('Stopped')
  }
}
