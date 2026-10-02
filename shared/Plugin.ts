// Taut Plugin Base Class: the class every plugin extends and the types plugins use

import type { BaseTautAPI, TautAPI } from '../app/pluginManager'
import type { PluginAuthors } from './authors'

export type { StoredAccount } from '../app/api/accountSwitcher'
export type {
  BasicSelectProps,
  BlocksProps,
  CheckboxProps,
  DateRangePickerProps,
  FieldSetProps,
  FilterPillProps,
  HintProps,
  LegendProps,
  MenuTemplateItem,
  SelectOption,
  TimePickerProps,
} from '../app/api/elements'
export type { MenuProps } from '../app/api/menu'
export type { ModalHandle, OpenModalOptions } from '../app/api/modal'
export type { StoredStore } from '../app/api/pluginStorage'
export type { SharedStore, SharedStoreHandle } from '../app/api/sharedStore'
export type { UserAPIOptions } from '../app/api/userAPI'
export type { TautAPI } from '../app/pluginManager'
export type {
  Block,
  FromDraftOptions,
  RichTextElement,
  RichTextElementContext,
  RichTextSectionContext,
} from '../app/slack/blocks'
export type {
  ComposerBroadcast,
  ComposerButton,
  ComposerButtonDisplay,
  ComposerContext,
  ComposerKind,
  InlineFormat,
  InlineMarkup,
  MarkupSpan,
} from '../app/slack/composer'
export type {
  ExperimentAssignment,
  ExperimentGroup,
  ForcedExperiments,
} from '../app/slack/experiments'
export type { MessageSendTransform } from '../app/slack/messageSend'
export type {
  SlackActivityItem,
  SlackAttachment,
  SlackBot,
  SlackMessage,
} from '../app/slack/messages'
export type { SlackStatus } from '../app/slack/profile'
export type { ComponentType, componentReplacer } from '../app/slack/react'
export type { RtmEvent } from '../app/slack/rtm'
export type { Author, AuthorKey, PluginAuthors } from './authors'

export interface TautPluginConfig {
  enabled: boolean
  [key: string]: unknown
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** settings groups in display order, a missing or unknown `category` goes under "Other" */
export const PLUGIN_CATEGORIES = {
  messages: 'Messages',
  messageBox: 'Message Box',
  people: 'People',
  privacy: 'Privacy',
  app: 'App',
  fun: 'Fun',
} as const
export type PluginCategory = keyof typeof PLUGIN_CATEGORIES

/** a choice for `opt.select`, optionally with its own label */
export type SelectChoice<V extends string = string> =
  | V
  | { value: V; label: string }

/** set by the `opt.*` helpers, otherwise inferred from the default's type */
export type OptionKind =
  | { type: 'boolean' }
  | { type: 'number'; min?: number; max?: number }
  | { type: 'string' }
  | { type: 'select'; options: { value: string; label: string }[] }
  | { type: 'list' }
  | { type: 'color' }
  | { type: 'json' }
  | { type: 'secret' }

export const WEEKDAYS = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
] as const
export type Weekday = (typeof WEEKDAYS)[number]

/** for `this.api.scheduleEnd`, 24-hour `"HH:MM"` times, an end at or before the start is the next day */
export type ScheduleWindow = { days: Weekday[]; start: string; end: string }

/** props for an option's custom `editor` */
export type OptEditorProps<T> = {
  value: T
  /** saves it, once it passes the option's checks */
  onChange: (value: T) => void
  /** the option's label, to name controls for screen readers */
  label: string
  /** works whether or not the plugin is running, so nothing in it is scoped */
  api: BaseTautAPI
}

export type OptOptions<T> = {
  /** shown in settings instead of the one made from the key */
  label?: string
  /** edits the value in settings, in place of the control its type gets */
  editor?: React.ComponentType<OptEditorProps<T>>
  /** why a value is invalid, or null if it can (only its top-level type is checked before this) */
  check?: (value: T) => string | null
}

export class Opt<T> {
  readonly label?: string
  readonly editor?: React.ComponentType<OptEditorProps<any>>
  readonly check?: (value: any) => string | null
  readonly kind?: OptionKind

  constructor(
    readonly value: T,
    readonly comment: string,
    options?: OptOptions<T> & { kind?: OptionKind }
  ) {
    this.label = options?.label
    this.editor = options?.editor
    this.check = options?.check
    this.kind = options?.kind
  }
}

type IsUnion<T, U = T> = T extends U ? ([U] extends [T] ? false : true) : never
export type Widen<T> =
  IsUnion<T> extends true
    ? T
    : T extends string
      ? string
      : T extends number
        ? number
        : T extends boolean
          ? boolean
          : T

/** `keepFirstLetter` -> "Keep first letter" */
export function labelFromKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** a config option with help text, the control follows the default's type unless `opt.*` or `editor` picks one */
function baseOpt<T extends JsonValue>(
  value: T,
  comment: string,
  options?: OptOptions<Widen<T>>
): Opt<Widen<T>> {
  return new Opt(value as Widen<T>, comment, options)
}

export const opt = Object.assign(baseOpt, {
  /** one of a fixed set of strings, shown as a dropdown */
  select<const V extends string>(
    choices: readonly SelectChoice<V>[],
    value: NoInfer<V>,
    comment: string,
    options?: OptOptions<V>
  ): Opt<V> {
    const normalized = choices.map((choice) =>
      typeof choice === 'string'
        ? { value: choice, label: labelFromKey(choice) }
        : choice
    )
    return new Opt(value, comment, {
      ...options,
      kind: { type: 'select', options: normalized },
    })
  },
  /** a list of strings, edited one item per row */
  list(
    value: readonly string[],
    comment: string,
    options?: OptOptions<string[]>
  ): Opt<string[]> {
    return new Opt([...value], comment, { ...options, kind: { type: 'list' } })
  },
  /** any CSS color, with a color picker */
  color(
    value: string,
    comment: string,
    options?: OptOptions<string>
  ): Opt<string> {
    return new Opt(value, comment, { ...options, kind: { type: 'color' } })
  },
  /** `min` and `max` bound only the settings control, any number in config.json is still used */
  number(
    value: number,
    comment: string,
    options?: OptOptions<number> & { min?: number; max?: number }
  ): Opt<number> {
    const { min, max, ...rest } = options ?? {}
    return new Opt(value, comment, {
      ...rest,
      kind: { type: 'number', min, max },
    })
  },
  /** stored in secret storage, not config.json (a value typed there moves over), read from `this.config`, changing it restarts the plugin, empty when unset */
  secret(comment: string, options?: { label?: string }): Opt<string> {
    return new Opt('', comment, { ...options, kind: { type: 'secret' } })
  },
})

export type DefaultConfig = { enabled: boolean | Opt<boolean> } & Record<
  string,
  JsonValue | Opt<JsonValue>
>

type Unwrap<T> = T extends Opt<infer V> ? V : T

export type PluginLike = { defaultConfig: DefaultConfig }

export type PluginConfig<P extends PluginLike> = PluginLike extends P
  ? TautPluginConfig
  : {
      -readonly [K in keyof P['defaultConfig']]: Unwrap<P['defaultConfig'][K]>
    } & { [key: string]: unknown }

/** pass the class back as the type param to type `this.config`, like `class MyPlugin extends TautPlugin<typeof MyPlugin>` */
export abstract class TautPlugin<P extends PluginLike = PluginLike> {
  /** must match the config key, should match the class name and filename */
  static readonly id: string
  static readonly pluginName: string
  /** short, in mrkdwn */
  static readonly description: string
  /** keys of `AUTHORS` in shared/authors.ts (array `as const`), `{ name, slackId?, url? }`, or mrkdwn with <@user_id> */
  static readonly authors: PluginAuthors
  /** use  `opt` to add descriptions, validation, etc */
  static readonly defaultConfig: DefaultConfig
  /** the settings group it's listed under, "Other" if unset */
  static readonly category?: PluginCategory
  /** never started or shown in settings outside the Hack Club Slack */
  static readonly hackClubOnly?: boolean

  /** shown in the Data section of its settings page while running, keep hooks inside the component it renders */
  dataPanel?(): React.ReactNode

  constructor(
    protected api: TautAPI,
    protected config: PluginConfig<P>
  ) {}

  /** only await fast local setup, run network work in the background and cancel it with `this.api.signal` */
  abstract start(): void | Promise<void>

  /** cleans up anything outside TautAPI, TautAPI registrations are disposed automatically */
  stop(): void | Promise<void> {}

  protected log = this._log.bind(this)
  protected _log(...args: unknown[]) {
    console.log(
      `[Taut] [${(this.constructor as typeof TautPlugin).pluginName}]`,
      ...args
    )
  }
}

export default TautPlugin
export interface TautPluginConstructor {
  new (api: TautAPI, config: any): TautPlugin
  readonly id: string
  readonly pluginName: string
  readonly description: string
  /** typed loosely, a user plugin may name an author the registry lacks */
  readonly authors: string | readonly unknown[]
  readonly defaultConfig: DefaultConfig
  /** typed loosely, older or newer user plugins may name another category */
  readonly category?: string
  readonly hackClubOnly?: boolean
}
