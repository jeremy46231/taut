// Taut Plugin Defaults: reads and checks a plugin's static defaultConfig

import {
  type DefaultConfig,
  type JsonValue,
  labelFromKey,
  Opt,
  type OptionKind,
} from '../shared/Plugin'
import { deepEqual } from './helpers'

export type DefaultEntry = {
  key: string
  value: JsonValue
  comment?: string
  label: string
  kind: OptionKind
  editor?: Opt<JsonValue>['editor']
  check?: Opt<JsonValue>['check']
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function checkValue(value: unknown, path: string): void {
  if (value === null) return
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`defaultConfig.${path} is not a finite number`)
      }
      return
    case 'object':
      if (Array.isArray(value)) {
        for (const [i, item] of value.entries())
          checkValue(item, `${path}[${i}]`)
        return
      }
      if (isPlainObject(value)) {
        for (const [key, item] of Object.entries(value)) {
          checkValue(item, `${path}.${key}`)
        }
        return
      }
      break
  }
  throw new Error(
    `defaultConfig.${path} must be JSON (string, number, boolean, null, array, or object)`
  )
}

export function validateDefaultConfig(defaults: unknown): void {
  if (!isPlainObject(defaults)) {
    throw new Error('defaultConfig must be a plain object')
  }
  for (const [key, raw] of Object.entries(defaults)) {
    if (!key.trim()) throw new Error('defaultConfig has an empty key')
    const value = raw instanceof Opt ? raw.value : raw
    if (raw instanceof Opt && typeof raw.comment !== 'string') {
      throw new Error(`defaultConfig.${key} has a non-string comment`)
    }
    checkValue(value, key)
  }
  const enabled = defaults.enabled
  const enabledValue = enabled instanceof Opt ? enabled.value : enabled
  if (typeof enabledValue !== 'boolean') {
    throw new Error('defaultConfig.enabled must be a boolean')
  }
  for (const entry of defaultEntries(defaults as DefaultConfig)) {
    const problem = checkOption(entry, entry.value)
    if (problem) throw new Error(`defaultConfig.${entry.key}: ${problem}`)
  }
}

export function defaultEntries(defaults: DefaultConfig): DefaultEntry[] {
  return Object.entries(defaults).map(([key, raw]) => {
    const opt = raw instanceof Opt ? raw : null
    const value = opt ? opt.value : (raw as JsonValue)
    return {
      key,
      value,
      comment: opt?.comment,
      label: opt?.label ?? labelFromKey(key),
      kind: opt?.kind ?? inferKind(value, opt?.editor !== undefined),
      editor: opt?.editor,
      check: opt?.check,
    }
  })
}

/** with its own editor, a list of text may hold more than text */
function inferKind(value: JsonValue, hasEditor: boolean): OptionKind {
  switch (typeof value) {
    case 'boolean':
      return { type: 'boolean' }
    case 'number':
      return { type: 'number' }
    case 'string':
      return { type: 'string' }
  }
  const strings =
    !hasEditor &&
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string')
  return { type: strings ? 'list' : 'json' }
}

/** kept in secret storage rather than config.json, see `opt.secret` */
export const isSecret = (entry: DefaultEntry) => entry.kind.type === 'secret'

export function fileEntries(defaults: DefaultConfig): DefaultEntry[] {
  return defaultEntries(defaults).filter((entry) => !isSecret(entry))
}

export function withoutDefaults(
  defaults: DefaultConfig,
  block: Record<string, unknown>
): Record<string, unknown> {
  const fallback = unwrapDefaults(defaults)
  return Object.fromEntries(
    Object.entries(block).filter(
      ([key, value]) => !(key in fallback && deepEqual(value, fallback[key]))
    )
  )
}

/** a plugin's block with every option filled in, secrets left out */
export function withDefaults(
  defaults: DefaultConfig,
  block: unknown
): Record<string, unknown> {
  const full: Record<string, unknown> = {}
  for (const { key, value } of fileEntries(defaults)) full[key] = value
  return { ...full, ...(isPlainObject(block) ? block : {}) }
}

/** every option's default value, secrets included */
export function unwrapDefaults(
  defaults: DefaultConfig
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const { key, value } of defaultEntries(defaults)) out[key] = value
  return out
}

const describe = (value: unknown) =>
  value === undefined ? 'nothing' : JSON.stringify(value)

/** why `value` can't be used for this option, or null if it can */
export function checkOption(
  entry: DefaultEntry,
  value: unknown
): string | null {
  const problem = checkKind(entry, value)
  return problem ?? entry.check?.(value) ?? null
}

function checkKind(entry: DefaultEntry, value: unknown): string | null {
  const { kind } = entry
  const found = describe(value)
  switch (kind.type) {
    case 'boolean':
      return typeof value === 'boolean'
        ? null
        : `expected true or false, found ${found}`
    case 'number':
      // min and max only bound the settings form, config.json can go past them
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `expected a number, found ${found}`
    case 'string':
      return typeof value === 'string' ? null : `expected text, found ${found}`
    case 'secret':
      // never echo the value, it may be the secret
      return typeof value === 'string' ? null : 'expected text'
    case 'select':
      return kind.options.some((option) => option.value === value)
        ? null
        : `expected one of ${kind.options.map((o) => JSON.stringify(o.value)).join(', ')}, found ${found}`
    case 'list':
      return Array.isArray(value) &&
        value.every((item) => typeof item === 'string')
        ? null
        : `expected a list of text, found ${found}`
    case 'color':
      if (typeof value !== 'string') return `expected a color, found ${found}`
      return typeof CSS === 'undefined' || CSS.supports('color', value)
        ? null
        : `${found} isn't a CSS color`
    case 'json': {
      const fallback = entry.value
      if (fallback === null) return null
      if (Array.isArray(fallback)) {
        return Array.isArray(value) ? null : `expected a list, found ${found}`
      }
      if (typeof fallback === 'object') {
        return isPlainObject(value)
          ? null
          : `expected an object, found ${found}`
      }
      return null
    }
  }
}

/** the user's block over the defaults, an invalid value falls back to its default and goes in `problems` */
export function resolveConfig(
  defaults: DefaultConfig,
  block: unknown
): { config: Record<string, unknown>; problems: Record<string, string> } {
  const config: Record<string, unknown> = structuredClone(
    unwrapDefaults(defaults)
  )
  const problems: Record<string, string> = {}
  if (!isPlainObject(block)) return { config, problems }
  const entries = new Map(defaultEntries(defaults).map((e) => [e.key, e]))
  for (const [key, value] of Object.entries(block)) {
    const entry = entries.get(key)
    const problem = entry ? checkOption(entry, value) : null
    if (problem) {
      problems[key] = problem
      continue
    }
    config[key] = value
  }
  return { config, problems }
}
