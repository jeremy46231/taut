export type Variant = 'standard' | 'embedded'

export type Os = 'mac' | 'win' | 'linux'
export type Arch = 'x64' | 'arm64'
export type PlatformKey =
  | 'mac'
  | 'mac-x64'
  | 'win'
  | 'win-arm'
  | 'linux'
  | 'linux-arm'

export interface DesktopPlatform {
  os: Os
  arch: Arch
  /** electron-builder target names */
  targets: string[]
}

const LINUX_TARGETS = ['AppImage', 'deb', 'rpm', 'pacman']

export const DESKTOP_PLATFORMS: Record<PlatformKey, DesktopPlatform> = {
  mac: { os: 'mac', arch: 'arm64', targets: ['dmg'] },
  'mac-x64': { os: 'mac', arch: 'x64', targets: ['dmg'] },
  win: { os: 'win', arch: 'x64', targets: ['nsis'] },
  'win-arm': { os: 'win', arch: 'arm64', targets: ['nsis'] },
  linux: { os: 'linux', arch: 'x64', targets: LINUX_TARGETS },
  'linux-arm': { os: 'linux', arch: 'arm64', targets: LINUX_TARGETS },
}

export const PLATFORM_KEYS = Object.keys(DESKTOP_PLATFORMS) as PlatformKey[]

export const INSTALLER_EXTENSIONS = [
  'dmg',
  'exe',
  'AppImage',
  'deb',
  'rpm',
  'pacman',
]

export const variantSuffix = (variant: Variant) =>
  variant === 'embedded' ? '-embedded' : ''

/** filename stem shared by every installer for one platform and variant */
export const desktopArtifactStem = (key: PlatformKey, variant: Variant) =>
  `taut-${key}${variantSuffix(variant)}`

/** the platform key matching the machine running the build */
export function hostPlatformKey(): PlatformKey {
  const arm = process.arch === 'arm64'
  switch (process.platform) {
    case 'darwin':
      return arm ? 'mac' : 'mac-x64'
    case 'win32':
      return arm ? 'win-arm' : 'win'
    default:
      return arm ? 'linux-arm' : 'linux'
  }
}
