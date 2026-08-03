// Taut Config Store
// In-memory store for config.jsonc and user.css with change notifications
// Uses jsonc-parser for safe JSONC modifications that preserve comments

import type { TautBridge } from '../shared/TautBridge'
import { defaultUserCss, emptyConfig } from './bundledData'
import { initJsonc, type JsoncNode, type JsoncParser } from './cdn'

function processSnippet(raw: string): string {
  const lines = raw.split('\n')
  let start = 0
  let end = lines.length - 1
  while (start <= end && !lines[start].trim()) start++
  while (end >= start && !lines[end].trim()) end--
  const trimmed = lines.slice(start, end + 1)
  const minIndent = trimmed.reduce((min, line) => {
    if (!line.trim()) return min
    return Math.min(min, (line.match(/^( *)/)?.[1] ?? '').length)
  }, Infinity)
  const dedent = Number.isFinite(minIndent) ? minIndent : 0
  return trimmed.map((line) => line.slice(dedent)).join('\n')
}

function lineLeadingSpaces(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1
  return text.slice(lineStart, pos).match(/^( *)/)?.[1] ?? ''
}

function detectIndent(configText: string, objectNode: JsoncNode): string {
  const children: JsoncNode[] = objectNode.children ?? []
  if (children.length > 0) {
    return lineLeadingSpaces(configText, children[0].offset)
  }
  const closingPos: number = objectNode.offset + objectNode.length - 1
  // Closing } is on the same line as { (e.g. "plugins": {})
  const objectLineIndent = lineLeadingSpaces(configText, objectNode.offset)
  if (
    !/^\s*$/.test(
      configText.slice(
        configText.lastIndexOf('\n', closingPos - 1) + 1,
        closingPos
      )
    )
  ) {
    return `${objectLineIndent}  `
  }
  return `${lineLeadingSpaces(configText, closingPos)}  `
}

function insertSnippetIntoPlugins(
  jsonc: JsoncParser,
  configText: string,
  snippet: string
): string {
  const tree = jsonc.parseTree(configText, undefined, {
    allowTrailingComma: true,
  })
  if (!tree) return configText

  const pluginsNode = jsonc.findNodeAtLocation(tree, ['plugins'])
  if (pluginsNode?.type !== 'object') return configText

  const indent = detectIndent(configText, pluginsNode)
  // Re-scale snippet indentation from its own unit to the config's unit.
  const pluginsKeyIndent = lineLeadingSpaces(configText, pluginsNode.offset)
  const configUnit = indent.length - pluginsKeyIndent.length || 2
  const snippetLines = snippet.split('\n')
  const snippetUnit = snippetLines.reduce((min, line) => {
    const spaces = line.match(/^( +)/)
    return spaces ? Math.min(min, spaces[1].length) : min
  }, Infinity)
  const effectiveSnippetUnit = Number.isFinite(snippetUnit)
    ? snippetUnit
    : configUnit
  const indented = snippetLines
    .map((line) => {
      if (!line.trim()) return ''
      const spaces = (line.match(/^( *)/)?.[1] ?? '').length
      const level = Math.round(spaces / effectiveSnippetUnit)
      return indent + ' '.repeat(level * configUnit) + line.trimStart()
    })
    .join('\n')

  const closingBracePos: number = pluginsNode.offset + pluginsNode.length - 1

  // If } is on its own line, split before that line and restore its indent.
  // If } shares a line with { (e.g. "plugins": {}), insert right before }
  // and use the plugins key's line indent to reconstruct the closing line.
  const closingLineStart = configText.lastIndexOf('\n', closingBracePos - 1)
  const rawClosingLine =
    closingLineStart >= 0
      ? configText.slice(closingLineStart + 1, closingBracePos)
      : ''
  const closingLineIsOwn = /^\s*$/.test(rawClosingLine)
  const splitAt = closingLineIsOwn ? closingLineStart : closingBracePos
  const closingLineIndent = closingLineIsOwn ? rawClosingLine : pluginsKeyIndent

  const children: JsoncNode[] = pluginsNode.children ?? []

  if (children.length === 0) {
    return (
      configText.slice(0, splitAt) +
      '\n' +
      indented +
      '\n' +
      closingLineIndent +
      configText.slice(closingBracePos)
    )
  }

  const lastChild = children[children.length - 1]
  const afterLastPos: number = lastChild.offset + lastChild.length
  const between = configText.slice(afterLastPos, closingBracePos)
  const hasTrailingComma = /,/.test(
    between.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  )

  // When the original had a trailing comma, preserve that style on the new entry too.
  const trailingComma = hasTrailingComma ? ',' : ''

  if (hasTrailingComma) {
    return (
      configText.slice(0, splitAt) +
      '\n' +
      indented +
      trailingComma +
      '\n' +
      closingLineIndent +
      configText.slice(closingBracePos)
    )
  }

  return (
    configText.slice(0, afterLastPos) +
    ',' +
    configText.slice(afterLastPos, splitAt) +
    '\n' +
    indented +
    '\n' +
    closingLineIndent +
    configText.slice(closingBracePos)
  )
}

export interface TautConfig {
  plugins: Record<string, { enabled: boolean } & Record<string, unknown>>
}

type Listener<T> = (value: T) => void
type Unsubscribe = () => void

export class ConfigStore {
  private configText = ''
  private userCssText = ''
  private config: TautConfig = { plugins: {} }
  private configListeners = new Set<Listener<TautConfig>>()
  private configTextListeners = new Set<Listener<string>>()
  private cssListeners = new Set<Listener<string>>()
  private jsonc!: JsoncParser
  private ensureConfigQueue: Promise<void> = Promise.resolve()

  constructor(private bridge: TautBridge) {}

  async init(): Promise<void> {
    this.jsonc = await initJsonc()
    this.configText = (await this.bridge.readConfigText()) || emptyConfig
    this.userCssText = (await this.bridge.readUserCss()) || defaultUserCss
    this.config = this.parseConfig(this.configText)

    this.bridge.onConfigTextChange((text) => {
      this.configText = text
      this.config = this.parseConfig(text)
      this.notifyConfigTextListeners()
      this.notifyConfigListeners()
    })

    this.bridge.onUserCssChange((css) => {
      this.userCssText = css
      this.notifyCssListeners()
    })
  }

  private parseConfig(text: string): TautConfig {
    try {
      const parsed = this.jsonc.parse(text, undefined, {
        allowTrailingComma: true,
      }) as TautConfig | null
      return parsed && typeof parsed === 'object' ? parsed : { plugins: {} }
    } catch {
      return { plugins: {} }
    }
  }

  getConfig(): TautConfig {
    return this.config
  }

  getConfigText(): string {
    return this.configText
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

  async updateConfigText(newText: string): Promise<boolean> {
    const success = await this.bridge.writeConfigText(newText)
    if (success) {
      this.configText = newText
      this.config = this.parseConfig(newText)
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

  async setPluginEnabled(
    pluginName: string,
    enabled: boolean
  ): Promise<boolean> {
    const edits = this.jsonc.modify(
      this.configText,
      ['plugins', pluginName, 'enabled'],
      enabled,
      {
        formattingOptions: { tabSize: 2, insertSpaces: true },
      }
    )
    const newText = this.jsonc.applyEdits(this.configText, edits)
    return this.updateConfigText(newText)
  }

  // Inserts a plugin's default JSONC snippet if the plugin has no config entry yet.
  // Calls are serialized so concurrent plugin loads can't race each other.
  async ensurePluginConfig(
    pluginName: string,
    snippet: string | undefined
  ): Promise<void> {
    if (!snippet) return
    const task = async () => {
      if (this.config.plugins[pluginName] !== undefined) return
      const processed = processSnippet(snippet)
      const newText = insertSnippetIntoPlugins(
        this.jsonc,
        this.configText,
        processed
      )
      if (newText === this.configText) return
      const parsed = this.parseConfig(newText)
      if (parsed.plugins[pluginName] === undefined) {
        throw new Error('Failed to insert plugin config snippet')
      }
      if (!(await this.updateConfigText(newText))) {
        throw new Error(`Failed to save config for plugin ${pluginName}`)
      }
    }
    this.ensureConfigQueue = this.ensureConfigQueue.catch(() => {}).then(task)
    return this.ensureConfigQueue
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
