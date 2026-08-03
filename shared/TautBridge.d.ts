// Taut Bridge Interface
// Defines the interface for communication between the app and backends
// Implemented by ElectronBackend (IPC), extensionBridge (WebExtension storage),
// and UserscriptBackend (GM_*)

/**
 * Plugin configuration object stored in config.jsonc
 * Each plugin has an `enabled` flag and can have additional custom properties
 */
export type TautPluginConfig = {
  enabled: boolean
  [key: string]: unknown
}

/**
 * Paths to Taut directories and files
 * Used by Electron backend for filesystem operations
 */
export type TautPaths = {
  /** Root Taut configuration directory */
  tautDir: string
  /** Directory containing core plugins */
  plugins: string
  /** Directory containing user plugins */
  userPlugins: string
  /** Path to config.jsonc file */
  config: string
  /** Path to user.css file */
  userCss: string
  /** Path to preload.js file (Electron only) */
  preloadJs?: string
  /** Display-friendly versions of paths (with ~ for home dir) */
  display: Record<string, string>
}

/** Cleanup function returned by subscription methods */
export type Unsubscribe = () => void

/** Generic string key/value store scoped to a caller-chosen namespace */
export type BlobStore = {
  /** List all keys currently stored in this namespace. */
  list(): Promise<string[]>
  /** Read a value, or null if not found. */
  read(key: string): Promise<string | null>
  /** Write (create or overwrite) a value. @returns true on success. */
  write(key: string, value: string): Promise<boolean>
  /** Delete a single key. @returns true on success. */
  delete(key: string): Promise<boolean>
  /** Delete every key in this namespace. @returns true on success. */
  clear(): Promise<boolean>
}

export type TautCookie = {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'no_restriction' | 'lax' | 'strict' | 'unspecified'
  /** Expiry in Unix seconds. Omit for a session cookie. */
  expirationDate?: number
}

/**
 * TautBridge interface
 * Abstracts the communication layer between the app and backend.
 * Implemented by each loader: Chrome extension, Firefox extension, Electron preload.
 */
export type TautBridge = {
  /** Which loader is providing this bridge */
  readonly loader:
    | 'chrome-extension'
    | 'firefox-extension'
    | 'electron'
    | 'userscript'
  /** Semver version string of this loader (e.g. '1.0.0'). */
  readonly loaderVersion: string

  /**
   * Monotonic integer version of this loader's bridge API implementation
   */
  readonly bridgeVersion: number

  /**
   * Called by the app when bridgeVersion is below the required minimum.
   * The loader should show UI informing the user to update, then return.
   * After this returns, the app will exit without patching Slack.
   */
  warnOutdated(): void

  /**
   * Initialize the backend
   * Electron: fetches PATHS from main process
   * Extension: seeds config defaults in WebExtension storage
   * Userscript: loads config from GM_getValue
   */
  start(): Promise<void>

  /**
   * Read the raw config.jsonc text
   * @returns Promise resolving to config file contents
   */
  readConfigText(): Promise<string>

  /**
   * Write raw text to config.jsonc
   * @param text - New config file contents
   * @returns Promise resolving to true on success
   */
  writeConfigText(text: string): Promise<boolean>

  /**
   * Subscribe to config text changes (for editor sync)
   * @param cb - Callback receiving new config text
   * @returns Unsubscribe function
   */
  onConfigTextChange(cb: (text: string) => void): Unsubscribe

  /**
   * Read the raw user.css text
   * @returns Promise resolving to user.css contents
   */
  readUserCss(): Promise<string>

  /**
   * Write raw text to user.css
   * @param text - New CSS contents
   * @returns Promise resolving to true on success
   */
  writeUserCss(text: string): Promise<boolean>

  /**
   * Subscribe to user.css changes
   * @param cb - Callback receiving new CSS text
   * @returns Unsubscribe function
   */
  onUserCssChange(cb: (css: string) => void): Unsubscribe

  /**
   * CORS-bypassing fetch.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>

  /**
   * Cookie read/write outside the page sandbox, or `null` if the loader can't
   * do it (e.g. a userscript manager without `GM_cookie`).
   */
  readonly cookies: null | {
    get(details: { url: string; name: string }): Promise<TautCookie | null>
    getAll(details: {
      url?: string
      domain?: string
      name?: string
    }): Promise<TautCookie[]>
    /** `url` selects the cookie store and provides default domain/path. */
    set(cookie: TautCookie & { url: string }): Promise<boolean>
    remove(details: { url: string; name: string }): Promise<boolean>
  }

  /**
   * Taut-private key/value store for secrets (e.g. saved account tokens),
   * backed by GM storage / `chrome.storage.local` / a file in `tautDir`. Kept
   * out of `config.jsonc` (user-editable, shown in the editor).
   * @returns the stored string, or `null` if unset.
   */
  readSecret(key: string): Promise<string | null>
  /** Write a secret. @returns true on success. Added in bridgeVersion 2. */
  writeSecret(key: string, value: string): Promise<boolean>

  /** Read-write store of pre-compiled user plugin code, keyed by plugin id. */
  readonly userPlugins: {
    list(): Promise<string[]>
    read(id: string): Promise<string | null>
    write(id: string, code: string): Promise<boolean>
    delete(id: string): Promise<boolean>
    /** Subscribe to external user plugin changes */
    onChange(cb: (id: string, code: string | null) => void): Unsubscribe
  }

  /** Get a BlobStore scoped to a specific namespace */
  blobStore(namespace: string): BlobStore

  /**
   * Paths to Taut directories and files
   * TautPaths object in Electron, or null in extension/userscript mode
   */
  PATHS: TautPaths | null
}

declare global {
  interface Window {
    TautBridge: TautBridge
  }
}
