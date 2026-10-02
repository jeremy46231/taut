// Enables Slack's pop-out windows in the browser

import { TautPlugin } from '$taut'

export default class BrowserPopouts extends TautPlugin<typeof BrowserPopouts> {
  static readonly id = 'BrowserPopouts'
  static readonly pluginName = 'Browser Pop-outs'
  static readonly description = "Enables Slack's pop-out windows in the browser"
  static readonly authors = ['jeremy'] as const
  static readonly category = 'app'
  static readonly defaultConfig = {
    enabled: true,
  }

  private originalGet: URLSearchParams['get'] | null = null

  start(): void {
    const originalGet = URLSearchParams.prototype.get
    this.originalGet = originalGet
    URLSearchParams.prototype.get = function (name: string) {
      const value = originalGet.call(this, name)
      return name === 'windowing' && value === null ? '1' : value
    }
  }

  stop(): void {
    if (!this.originalGet) return
    URLSearchParams.prototype.get = this.originalGet
    this.originalGet = null
  }
}
