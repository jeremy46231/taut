// taut-versions.json is built by scripts/build/versions.ts and served with the desktop ledger by server/src/index.ts

import type {
  TautBridge,
  TautDesktopPlatform,
  TautInstallType,
} from './TautBridge'

export const VERSIONS_URL = 'https://taut.jer.app/taut-versions.json'
export const INSTALL_HELP_URL = 'https://github.com/jeremy46231/taut#quickstart'

export const DESKTOP_FEED_URL = 'https://taut.jer.app/desktop/'

// electron-builder appends `-mac` or `-linux` and the arch, so arm64 needs its own channel only on mac and Windows
export const DESKTOP_UPDATE_CHANNELS: Record<
  TautDesktopPlatform,
  { channel: string; file: string }
> = {
  mac: { channel: 'latest-arm64', file: 'latest-arm64-mac.yml' },
  'mac-x64': { channel: 'latest', file: 'latest-mac.yml' },
  win: { channel: 'latest', file: 'latest.yml' },
  'win-arm': { channel: 'latest-arm64', file: 'latest-arm64.yml' },
  linux: { channel: 'latest', file: 'latest-linux.yml' },
  'linux-arm': { channel: 'latest', file: 'latest-linux-arm64.yml' },
}

export type LoaderName = TautBridge['loader']

export type DesktopFormat =
  | 'dmg'
  | 'exe'
  | 'AppImage'
  | 'deb'
  | 'rpm'
  | 'pacman'

export interface LoaderVersions {
  latest: string
  /** versions below this get an update notice */
  recommended: string
  url: string
}

export interface DesktopFile {
  /** immutable, from the `desktop-v*` release */
  url: string
}

export interface DesktopRelease {
  version: string
  files: Partial<Record<DesktopFormat, DesktopFile>>
}

export interface DesktopVersions {
  /** the newest version any platform has, null before the first release */
  latest: string | null
  recommended: string
  /** only platforms whose installers are published */
  platforms: Partial<Record<TautDesktopPlatform, DesktopRelease>>
}

/** one `desktop-v*` release in the server's ledger, merged from each desktop leg's report */
export interface DesktopReleaseRecord {
  version: string
  /** every file published to the release, by name */
  assets: Record<string, { url: string; sha256: string; size: number }>
  /** platforms with every installer uploaded */
  platforms: Partial<Record<TautDesktopPlatform, DesktopRelease['files']>>
  /** update ymls by file name, with urls pointing at `assets` */
  feeds: Record<string, string>
}

export interface VersionsFile {
  schema: 1
  /** the taut.js taut.jer.app serves */
  app: { version: string }
  loaders: {
    'chrome-extension': LoaderVersions
    'firefox-extension': LoaderVersions
    userscript: LoaderVersions
    electron: DesktopVersions
  }
}

/** compares the numeric x.y.z part, anything after `-` or `+` is ignored */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

/** package manager installs update through it, never by hand */
export function updateCommand(type: TautInstallType | null): string | null {
  switch (type) {
    case 'homebrew':
      return 'brew upgrade --cask taut'
    case 'apt':
      return 'sudo apt update && sudo apt install --only-upgrade taut'
    case 'dnf':
      return 'sudo dnf upgrade --refresh taut'
    default:
      return null
  }
}

export function desktopDownload(
  type: TautInstallType | null,
  platform: TautDesktopPlatform,
  desktop: DesktopVersions
): DesktopFile | null {
  const files = desktop.platforms[platform]?.files
  if (!files) return null
  const typeFormat: Partial<Record<TautInstallType, DesktopFormat>> = {
    nsis: 'exe',
    mac: 'dmg',
    'mac-adhoc': 'dmg',
    'mac-readonly': 'dmg',
    appimage: 'AppImage',
    deb: 'deb',
    rpm: 'rpm',
    pacman: 'pacman',
  }
  // an older desktop copy can't say how it was installed
  const format =
    type && type !== 'unknown'
      ? typeFormat[type]
      : platform.startsWith('mac')
        ? 'dmg'
        : platform.startsWith('win')
          ? 'exe'
          : 'AppImage'
  return (format && files[format]) || null
}
