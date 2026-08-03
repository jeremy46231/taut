// Blocks Slack's built-in tracking requests
// Pattern list sourced from uAssets and AdGuard filters via 3kh0/slick

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

const BLOCKED_RESPONSE = new Response('', { status: 200 })

export default class NoTrack extends TautPlugin {
  static readonly id = 'NoTrack'
  static readonly pluginName = 'No Tracking'
  static readonly description =
    "Blocks Slack's built-in tracking and analytics requests"
  static readonly authors = '<@U080A3QP42C>, <@U06UYA5GMB5>'
  static readonly defaultConfig = `
    // Blocks Slack's built-in tracking and analytics requests
    "NoTrack": {
      "enabled": true
    }
  `

  private matchers: RegExp[] = []
  private originalFetch: typeof window.fetch | null = null
  private originalXHROpen: typeof XMLHttpRequest.prototype.open | null = null

  private isBlocked(url: string): boolean {
    return this.matchers.some((re) => re.test(url))
  }

  private static urlString(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.href
    return (input as Request).url
  }

  start(): void {
    this.matchers = TRACKING_PATTERNS.map(globToRegex)

    // Patch fetch
    this.originalFetch = window.fetch
    const originalFetch = this.originalFetch
    // @ts-expect-error our arrow function lacks non-essential static fetch properties
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (this.isBlocked(NoTrack.urlString(input))) {
        return Promise.resolve(BLOCKED_RESPONSE.clone())
      }
      return originalFetch(input, init)
    }

    // Patch XHR
    this.originalXHROpen = XMLHttpRequest.prototype.open
    const originalOpen = this.originalXHROpen
    const isBlocked = this.isBlocked.bind(this)
    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      ...rest: any[]
    ) {
      if (isBlocked(url.toString())) {
        this.send = () => {}
        return
      }
      return Reflect.apply(originalOpen, this, [method, url, ...rest])
    }

    this.log('Started, blocking', this.matchers.length, 'patterns')
  }

  stop(): void {
    if (this.originalFetch) {
      window.fetch = this.originalFetch
      this.originalFetch = null
    }
    if (this.originalXHROpen) {
      XMLHttpRequest.prototype.open = this.originalXHROpen
      this.originalXHROpen = null
    }
    this.matchers = []
    this.log('Stopped')
  }
}
