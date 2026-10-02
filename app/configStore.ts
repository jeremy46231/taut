// Taut Config Store: config.json and user.css in memory, with change notifications

import type { DefaultConfig, JsonValue } from '../shared/Plugin'
import type { TautBridge } from '../shared/TautBridge'
import { defaultUserCss } from './bundledData'
import { initJsonc, type ParseError } from './cdn'
import { deepEqual } from './helpers'
import { withoutDefaults } from './pluginConfig'

export interface TautConfig {
  plugins: Record<string, Record<string, unknown>>
  telemetry?: boolean
  /** the What's new megaphone in Slack's top bar */
  whatsNewButton?: boolean
}

/** root keys left out of the file while they have these values */
const ROOT_DEFAULTS: Record<string, JsonValue> = {
  telemetry: true,
  whatsNewButton: true,
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** whether parsed JSON is a config Taut can use, `plugins` filled in if it's missing */
export function checkConfig(
  parsed: unknown
): { config: TautConfig } | { error: string } {
  if (!isObject(parsed)) return { error: 'the file must be a JSON object' }
  parsed.plugins ??= {}
  if (!isObject(parsed.plugins)) return { error: '"plugins" must be an object' }
  return { config: parsed as unknown as TautConfig }
}

/** anything but plain JSON is the commented JSON Taut wrote before 3.0, parsed with jsonc-parser loaded only for it */
async function parseConfig(
  text: string
): Promise<{ config: TautConfig; plain: boolean } | { error: string }> {
  if (!text.trim()) return { config: { plugins: {} }, plain: true }
  let parsed: unknown
  let plain = true
  try {
    parsed = JSON.parse(text)
  } catch {
    plain = false
    let jsonc: Awaited<ReturnType<typeof initJsonc>>
    try {
      jsonc = await initJsonc()
    } catch (err) {
      return { error: `couldn't load jsonc-parser: ${err}` }
    }
    const { parse, printParseErrorCode } = jsonc
    const errors: ParseError[] = []
    parsed = parse(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const [{ error, offset }] = errors
      return { error: `${printParseErrorCode(error)} at character ${offset}` }
    }
  }
  const checked = checkConfig(parsed)
  return 'error' in checked ? checked : { ...checked, plain }
}

/** how Taut always writes config.json */
export const configText = (config: unknown) =>
  `${JSON.stringify(config, null, 2)}\n`

type Listener<T> = (value: T) => void
type Unsubscribe = () => void

export class ConfigStore {
  private configText = ''
  private userCssText = ''
  private config: TautConfig = { plugins: {} }
  /** why the file can't be read, it's never overwritten while this is set */
  private parseError: string | null = null
  /** false for the commented JSON Taut wrote before 3.0 */
  private plainJson = true
  private textSeq = 0
  private configListeners = new Set<Listener<TautConfig>>()
  private configTextListeners = new Set<Listener<string>>()
  private cssListeners = new Set<Listener<string>>()
  private editQueue: Promise<void> = Promise.resolve()

  constructor(private bridge: TautBridge) {}

  async init(): Promise<void> {
    await this.setText(await this.bridge.readConfigText())
    this.userCssText = (await this.bridge.readUserCss()) || defaultUserCss

    this.bridge.onConfigTextChange(async (text) => {
      if (!(await this.setText(text))) return
      this.notifyConfigTextListeners()
      this.notifyConfigListeners()
    })

    this.bridge.onUserCssChange((css) => {
      this.userCssText = css
      this.notifyCssListeners()
    })
  }

  /** false when a later call started while this one was parsing and will handle the change, so this applied nothing and the caller shouldn't notify */
  private async setText(text: string): Promise<boolean> {
    const seq = ++this.textSeq
    const parsed = await parseConfig(text)
    if (seq !== this.textSeq) return false
    this.configText =
      text.trim() || !('config' in parsed) ? text : configText(parsed.config)
    if ('error' in parsed) {
      console.error(`[Taut] Can't read config.json: ${parsed.error}`)
      this.parseError = parsed.error
      this.config = { plugins: {} }
    } else {
      this.parseError = null
      this.config = parsed.config
      this.plainJson = parsed.plain
    }
    return true
  }

  getConfig(): TautConfig {
    return this.config
  }

  getConfigText(): string {
    return this.configText
  }

  getParseError(): string | null {
    return this.parseError
  }

  getUserCssText(): string {
    return this.userCssText
  }

  onConfigChange(listener: Listener<TautConfig>): Unsubscribe {
    this.configListeners.add(listener)
    return () => this.configListeners.delete(listener)
  }

  onConfigTextChange(listener: Listener<string>): Unsubscribe {
    this.configTextListeners.add(listener)
    return () => this.configTextListeners.delete(listener)
  }

  onUserCssChange(listener: Listener<string>): Unsubscribe {
    this.cssListeners.add(listener)
    return () => this.cssListeners.delete(listener)
  }

  updateConfigText(newText: string): Promise<boolean> {
    return this.queueEdit(() => this.writeText(newText))
  }

  private async writeText(newText: string): Promise<boolean> {
    const success = await this.bridge.writeConfigText(newText)
    if (success && (await this.setText(newText))) {
      this.notifyConfigTextListeners()
      this.notifyConfigListeners()
    }
    console.log(
      '[Taut] Config update',
      success ? 'succeeded' : 'failed',
      newText
    )
    return success
  }

  async updateUserCssText(newCss: string): Promise<void> {
    const success = await this.bridge.writeUserCss(newCss)
    if (success) {
      this.userCssText = newCss
      this.notifyCssListeners()
    }
    console.log(
      '[Taut] User CSS update',
      success ? 'succeeded' : 'failed',
      newCss
    )
  }

  /** queued so no edit is computed from stale text, false while the file can't be read */
  private edit(change: (config: TautConfig) => void): Promise<boolean> {
    return this.queueEdit(async () => {
      if (this.parseError) {
        console.error(`[Taut] Not saving config: ${this.parseError}`)
        return false
      }
      const config = structuredClone(this.config)
      change(config)
      if (this.plainJson && deepEqual(config, this.config)) return true
      return this.writeText(configText(config))
    })
  }

  /** e.g. `['plugins', id, key]` or `['telemetry']` */
  setConfigValue(path: string[], value: JsonValue): Promise<boolean> {
    return this.edit((config) => {
      let cursor = config as unknown as Record<string, unknown>
      for (const key of path.slice(0, -1)) {
        if (!isObject(cursor[key])) cursor[key] = {}
        cursor = cursor[key] as Record<string, unknown>
      }
      cursor[path[path.length - 1]] = value
    })
  }

  /** remove one value, and a plugin's block once it's empty */
  removeConfigValue(path: string[]): Promise<boolean> {
    return this.edit((config) => {
      const parents: Record<string, unknown>[] = []
      let cursor: unknown = config
      for (const key of path.slice(0, -1)) {
        if (!isObject(cursor)) return
        parents.push(cursor)
        cursor = cursor[key]
      }
      if (!isObject(cursor)) return
      delete cursor[path[path.length - 1]]
      // empty objects below the root key, e.g. a plugin's block
      for (let i = parents.length - 1; i >= 1; i--) {
        const child = parents[i][path[i]]
        if (isObject(child) && Object.keys(child).length === 0) {
          delete parents[i][path[i]]
        }
      }
    })
  }

  /** replace a plugin's block from an editor that showed `shown`: keys set before or changed from `shown` are kept, untouched ones stay unset */
  setPluginBlock(
    id: string,
    block: Record<string, unknown>,
    shown: Record<string, unknown>
  ): Promise<boolean> {
    return this.edit((config) => {
      const before = isObject(config.plugins[id]) ? config.plugins[id] : {}
      const stored = Object.fromEntries(
        Object.entries(block).filter(
          ([key, value]) =>
            key in before || !(key in shown) || !deepEqual(value, shown[key])
        )
      )
      if (Object.keys(stored).length) config.plugins[id] = stored
      else delete config.plugins[id]
    })
  }

  /** once, when the file is still pre-3.0 commented config.jsonc, which wrote every default, so a value equal to its default becomes unset; blocks of unknown plugins are kept as is */
  removeDefaults(defaultsById: Map<string, DefaultConfig>): Promise<boolean> {
    if (this.plainJson) return Promise.resolve(true)
    return this.edit((config) => {
      for (const [id, block] of Object.entries(config.plugins)) {
        const defaults = defaultsById.get(id)
        if (!defaults || !isObject(block)) continue
        const stored = withoutDefaults(defaults, block)
        if (Object.keys(stored).length) config.plugins[id] = stored
        else delete config.plugins[id]
      }
      const root = config as unknown as Record<string, unknown>
      for (const [key, value] of Object.entries(ROOT_DEFAULTS)) {
        if (deepEqual(root[key], value)) delete root[key]
      }
    })
  }

  private queueEdit<T>(task: () => Promise<T>): Promise<T> {
    const result = this.editQueue.catch(() => {}).then(task)
    this.editQueue = result.then(
      () => {},
      () => {}
    )
    return result
  }

  private notifyConfigListeners() {
    for (const listener of this.configListeners) {
      listener(this.config)
    }
    console.log('[Taut] Notified config listeners', this.config)
  }

  private notifyConfigTextListeners() {
    for (const listener of this.configTextListeners) {
      listener(this.configText)
    }
  }

  private notifyCssListeners() {
    for (const listener of this.cssListeners) {
      listener(this.userCssText)
    }
  }
}
