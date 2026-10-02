// Strips tracking parameters from links you paste into messages (rules from ClearURLs)

import { opt, TautPlugin } from '$taut'

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

type ExtraRule = { param: RegExp; host: RegExp | null }

const wildcard = (value: string) => RegExp.escape(value).replace(/\\\*/g, '.*?')

export default class ClearURLs extends TautPlugin<typeof ClearURLs> {
  static readonly id = 'ClearURLs'
  static readonly pluginName = 'Clear URLs'
  static readonly description =
    'Strips tracking parameters from links you paste into messages (rules from <https://github.com/ClearURLs/Rules|ClearURLs>)'
  static readonly authors = ['jeremy', 'rowan'] as const
  static readonly category = 'messageBox'
  static readonly defaultConfig = {
    enabled: false,
    extraRules: opt.list(
      [],
      'More parameters to strip: "param" or "param@host", "*" matches anything (e.g. "ref_*", "si@*.youtube.com")'
    ),
  }

  private cache = new this.api.Cache<RulesData>('clearurls_rules', {
    ttl: 7 * 24 * 60 * 60 * 1000,
  })
  private providers: Provider[] = []
  private extraRules: ExtraRule[] = []

  async start() {
    this.extraRules = this.compileExtraRules(this.config.extraRules)
    await this.cache.load()
    if (this.api.signal.aborted) return
    this.loadRules()
    this.api.composer.addLinkTransform((url) => this.cleanURL(url))
    this.log('Started')
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

  private compileExtraRules(rules: string[]): ExtraRule[] {
    return rules.flatMap((rule) => {
      const [param, host] = rule.trim().split('@')
      if (!param) return []
      try {
        return [
          {
            param: new RegExp(`^${wildcard(param)}$`, 'i'),
            // "*.example.com" also matches example.com itself
            host: host
              ? new RegExp(
                  `^(www\\.)?${RegExp.escape(host.toLowerCase())
                    .replace(/^\\\*\\\./, '(.+\\.)?')
                    .replace(/\\\*/g, '.*?')}$`
                )
              : null,
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
    let removed = 0
    const dropParams = (matches: (key: string) => boolean) => {
      const doomed: string[] = []
      parsed.searchParams.forEach((_, key) => {
        if (matches(key)) doomed.push(key)
      })
      for (const key of doomed) parsed.searchParams.delete(key)
      removed += doomed.length
    }

    for (const provider of this.providers) {
      if (!provider.urlPattern.test(parsed.href)) continue
      if (provider.exceptions.some((ex) => ex.test(parsed.href))) continue

      dropParams((key) => provider.rules.some((r) => r.test(key)))

      for (const raw of provider.rawRules) {
        const next = parsed.href.replace(raw, '')
        if (next === parsed.href) continue
        try {
          parsed = new URL(next)
          removed++
        } catch {}
      }
    }

    const host = parsed.hostname.toLowerCase()
    dropParams((key) =>
      this.extraRules.some(
        (rule) => rule.param.test(key) && (!rule.host || rule.host.test(host))
      )
    )

    // URL reserializes, so keep the original by default
    return removed ? parsed.toString() : url
  }
}
