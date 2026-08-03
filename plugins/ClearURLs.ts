// Strips tracking parameters from URLs before sending messages
// Rules sourced from the ClearURLs project: https://github.com/ClearURLs/Rules

import { type Delta, TautPlugin } from '$taut'

const URL_RE = /(https?:\/\/[^\s<|]+[^<.,:;"'>)|\]\s])/g

type RulesData = {
  providers: Record<
    string,
    {
      urlPattern: string
      rules?: string[]
      rawRules?: string[]
      exceptions?: string[]
    }
  >
}

type Provider = {
  urlPattern: RegExp
  rules: RegExp[]
  rawRules: RegExp[]
  exceptions: RegExp[]
}

export default class ClearURLs extends TautPlugin {
  static readonly id = 'ClearURLs'
  static readonly pluginName = 'Clear URLs'
  static readonly description =
    'Strips tracking parameters from URLs before sending messages (rules from <https://github.com/ClearURLs/Rules|ClearURLs>)'
  static readonly authors = '<@U080A3QP42C>, <@U06UYA5GMB5>'
  static readonly defaultConfig = `
    // Strips tracking parameters from URLs before sending messages
    // Rules sourced from https://github.com/ClearURLs/Rules
    "ClearURLs": {
      "enabled": false
    }
  `

  private cache = new this.api.Cache<RulesData>('clearurls_rules', {
    ttl: 7 * 24 * 60 * 60 * 1000,
  })
  private providers: Provider[] = []

  async start() {
    await this.cache.load()
    if (this.api.signal.aborted) return
    this.loadRules()
    this.api.onMessageSendDelta((delta) => this.cleanDelta(delta))
    this.log('Started')
  }

  stop(): void {
    this.providers = []
    this.log('Stopped')
  }

  private async loadRules(): Promise<void> {
    const cached = this.cache.get('data')
    if (cached) {
      this.buildProviders(cached)
      this.log(
        'Loaded rules from cache:',
        Object.keys(cached.providers).length,
        'providers'
      )
      return
    }

    try {
      const response = await fetch(
        'https://raw.githubusercontent.com/ClearURLs/Rules/master/data.min.json',
        { signal: this.api.signal }
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as RulesData
      this.cache.set('data', data)
      this.buildProviders(data)
      this.log(
        'Fetched rules:',
        Object.keys(data.providers).length,
        'providers'
      )
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      this.log('Failed to fetch rules:', e)
    }
  }

  private buildProviders(data: RulesData): void {
    this.providers = Object.values(data.providers).flatMap((p) => {
      try {
        return [
          {
            urlPattern: new RegExp(p.urlPattern, 'i'),
            rules: (p.rules ?? []).map((r) => new RegExp(r, 'i')),
            rawRules: (p.rawRules ?? []).map((r) => new RegExp(r, 'i')),
            exceptions: (p.exceptions ?? []).map((r) => new RegExp(r, 'i')),
          },
        ]
      } catch {
        return []
      }
    })
  }

  private cleanURL(url: string): string {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return url
    }

    for (const provider of this.providers) {
      if (!provider.urlPattern.test(parsed.href)) continue
      if (provider.exceptions.some((ex) => ex.test(parsed.href))) continue

      const toDelete: string[] = []
      parsed.searchParams.forEach((_, key) => {
        if (provider.rules.some((r) => r.test(key))) toDelete.push(key)
      })
      for (const key of toDelete) parsed.searchParams.delete(key)

      for (const raw of provider.rawRules) {
        const next = parsed.href.replace(raw, '')
        if (next !== parsed.href) {
          try {
            parsed = new URL(next)
          } catch {}
        }
      }
    }

    return parsed.toString()
  }

  private cleanDelta(delta: Delta): Delta {
    if (this.providers.length === 0) return delta

    for (let i = 0; i < delta.ops.length; i++) {
      const op = delta.ops[i]
      if (!('insert' in op)) continue

      let insert = op.insert
      let attributes = op.attributes
      let opChanged = false

      if (attributes?.link && typeof attributes.link === 'string') {
        const cleanedLink = this.cleanURL(attributes.link)
        if (cleanedLink !== attributes.link) {
          if (typeof insert === 'string' && insert === attributes.link)
            insert = cleanedLink
          attributes = { ...attributes, link: cleanedLink }
          opChanged = true
        }
      }

      if (typeof insert === 'string' && /https?:\/\//.test(insert)) {
        const cleanedText = insert.replace(URL_RE, (url) => this.cleanURL(url))
        if (cleanedText !== insert) {
          insert = cleanedText
          opChanged = true
        }
      }

      if (opChanged) delta.ops[i] = { ...op, insert, attributes }
    }

    return delta
  }
}
