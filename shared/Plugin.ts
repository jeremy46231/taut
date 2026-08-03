// Taut Plugin Base Class
// Abstract class and types that all Taut plugins must extend
// Defines the TautAPI interface available to plugins

import type { TautAPI } from '../app/pluginManager'

export type { StoredAccount } from '../app/api/accountSwitcher'
export type { ModalHandle, OpenModalOptions } from '../app/api/modal'
export type { TautAPI } from '../app/pluginManager'
export type { ComponentType, componentReplacer } from '../app/slack/react'

export interface TautPluginConfig {
  enabled: boolean
  [key: string]: unknown
}

/**
 * Abstract base class that all Taut plugins must extend.
 * Plugins are instantiated in the browser context with access to the TautAPI.
 */
export abstract class TautPlugin {
  /** Must match config key, should match class name & filename */
  static readonly id: string
  /** The display name of the plugin. */
  static readonly pluginName: string
  /** A short description of the plugin in mrkdwn format. */
  static readonly description: string
  /** The authors of the plugin in mrkdwn format, using <@user_id> syntax. */
  static readonly authors: string

  /**
   * @param api - The TautAPI instance for plugin communication
   * @param config - The plugin's configuration from config.jsonc
   */
  constructor(
    protected api: TautAPI,
    protected config: TautPluginConfig
  ) {}

  /**
   * Called when the plugin should start. Only await fast local initialization;
   * run network work in the background and cancel it with `this.api.signal`.
   * Subclasses must implement this method.
   */
  abstract start(): void | Promise<void>

  /**
   * Called when the plugin should stop and clean up non-TautAPI resources.
   * TautAPI registrations are disposed automatically.
   */
  stop(): void | Promise<void> {
    // Default implementation does nothing
  }

  /**
   * Log a message with the plugin's name prefix.
   * @param args - Something to log
   */
  protected log = this._log.bind(this)
  protected _log(...args: any[]) {
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
  readonly authors: string
  readonly defaultConfig?: string
}

type DeltaOp = (
  | { insert?: string | object }
  | { delete?: number }
  | { retain?: number }
) & {
  attributes?: Record<string, any>
}

/**
 * A Quill Delta instance
 * @see https://github.com/slab/delta
 */
export declare class Delta {
  // Private brand prevents `{ ops: [...] }` from satisfying this type
  // Transforms must return the original instance (mutating ops most likely)
  private _quillDeltaBrand: never
  ops: DeltaOp[]
}
