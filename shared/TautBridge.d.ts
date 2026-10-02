// Taut Bridge Interface: what each loader gives the app as window.TautBridge

/** a plugin's entry in config.json, `enabled` plus its own options */
export type TautPluginConfig = {
  enabled: boolean
  [key: string]: unknown
}

export type TautPaths = {
  tautDir: string
  plugins: string
  userPlugins: string
  config: string
  userCss: string
  /** the same paths with ~ for the home dir, for showing */
  display: Record<string, string>
}

/** how a desktop copy was installed, see desktop/src/installType.ts */
export type TautInstallType =
  | 'nsis'
  | 'homebrew'
  | 'mac'
  | 'mac-adhoc'
  | 'mac-readonly'
  | 'appimage'
  | 'nix'
  | 'deb'
  | 'apt'
  | 'rpm'
  | 'dnf'
  | 'pacman'
  | 'embedded'
  | 'temporary'
  | 'dev'
  | 'unknown'

/** desktop installer platform, see scripts/lib/artifacts.ts */
export type TautDesktopPlatform =
  | 'mac'
  | 'mac-x64'
  | 'win'
  | 'win-arm'
  | 'linux'
  | 'linux-arm'

export type TautInstall = {
  type: TautInstallType
  /** the installer that fits this machine */
  platform: TautDesktopPlatform
  /** whether this copy installs updates by itself */
  canSelfUpdate: boolean
}

export type Unsubscribe = () => void

/** string key/value store scoped to a namespace */
export type BlobStore = {
  list(): Promise<string[]>
  /** null if unset */
  read(key: string): Promise<string | null>
  /** creates or overwrites, true on success */
  write(key: string, value: string): Promise<boolean>
  /** true on success */
  delete(key: string): Promise<boolean>
  /** deletes every key in the namespace, true on success */
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
  /** unix seconds, omit for a session cookie */
  expirationDate?: number
}

// structured-cloneable
export type SerialResponse = {
  status: number
  statusText?: string
  headers?: Record<string, string>
  /** desktop sends raw bytes since 3.1.0, older loaders a string */
  body?: string | Uint8Array<ArrayBuffer> | null
}

export type TautBridge = {
  readonly loader:
    | 'chrome-extension'
    | 'firefox-extension'
    | 'electron'
    | 'userscript'
  /** semver, like '1.0.0' */
  readonly loaderVersion: string
  readonly embedded?: boolean
  /** desktop only, older loaders leave it out */
  readonly install?: TautInstall
  /** restarts into the update `onUpdateReady` reports, only offered when `install.canSelfUpdate` */
  restartToUpdate?(): void
  /** calls back with the version once `restartToUpdate` would install it (right away if it already would), only offered when `install.canSelfUpdate` */
  onUpdateReady?(cb: (version: string) => void): Unsubscribe

  /** integer version of the bridge API, only goes up */
  readonly bridgeVersion: number

  /** called instead of loading when bridgeVersion is below the app's MIN_BRIDGE_VERSION, should tell the user to update */
  warnOutdated(): void

  /** awaited once before the app reads config (desktop starts its file watchers, the userscript seeds user.css) */
  start(): Promise<void>

  readConfigText(): Promise<string>

  /** true on success */
  writeConfigText(text: string): Promise<boolean>

  onConfigTextChange(cb: (text: string) => void): Unsubscribe

  readUserCss(): Promise<string>

  /** true on success */
  writeUserCss(text: string): Promise<boolean>

  onUserCssChange(cb: (css: string) => void): Unsubscribe

  /** fetch that bypasses CORS */
  fetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response | SerialResponse>

  /** cookie access outside the page sandbox, null when the loader can't (like a userscript manager without `GM_cookie`) */
  readonly cookies: null | {
    get(details: { url: string; name: string }): Promise<TautCookie | null>
    getAll(details: {
      url?: string
      domain?: string
      name?: string
    }): Promise<TautCookie[]>
    /** `url` picks the cookie store and the default domain and path */
    set(cookie: TautCookie & { url: string }): Promise<boolean>
    remove(details: { url: string; name: string }): Promise<boolean>
  }

  /** private store for secrets like account tokens, kept out of config.json, stored encrypted with the OS keychain if possible, null if unset */
  readSecret(key: string): Promise<string | null>
  /** true on success, added in bridgeVersion 2 */
  writeSecret(key: string, value: string): Promise<boolean>
  /** true on success, older loaders lack it */
  deleteSecret?(key: string): Promise<boolean>

  /** compiled user plugin code by plugin id */
  readonly userPlugins: {
    list(): Promise<string[]>
    read(id: string): Promise<string | null>
    write(id: string, code: string): Promise<boolean>
    delete(id: string): Promise<boolean>
    onChange(cb: (id: string, code: string | null) => void): Unsubscribe
  }

  blobStore(namespace: string): BlobStore

  /** desktop only, null in the extensions and userscript */
  PATHS: TautPaths | null
}

declare global {
  interface Window {
    TautBridge: TautBridge
  }
}
