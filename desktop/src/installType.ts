import { execFile } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type {
  TautDesktopPlatform,
  TautInstall,
  TautInstallType,
} from '../../shared/TautBridge'

declare const __TAUT_EMBEDDED__: boolean
/** see signingMarker in scripts/lib/macSigning.ts */
declare const __TAUT_MAC_SIGNING__: string

const run = promisify(execFile)

const writable = (dir: string) => {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

const safeRealpath = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function isNix(exe: string) {
  // nix-darwin and home-manager copy or link apps out of the store
  return (
    safeRealpath(exe).startsWith('/nix/store/') ||
    /\/(Nix|Home Manager) Apps\//.test(exe)
  )
}

// each version's Caskroom folder links to the app it moved into place, wherever its appdir was
function isCaskApp(bundle: string) {
  const real = safeRealpath(bundle)
  return ['/opt/homebrew/Caskroom/taut', '/usr/local/Caskroom/taut'].some(
    (caskroom) => {
      try {
        return readdirSync(caskroom).some(
          (version) =>
            !version.startsWith('.') &&
            safeRealpath(path.join(caskroom, version, 'Taut.app')) === real
        )
      } catch {
        return false
      }
    }
  )
}

function macType(exe: string): TautInstallType {
  // .../Taut.app/Contents/MacOS/Taut
  const bundle = path.resolve(exe, '..', '..', '..')
  if (isCaskApp(bundle)) return 'homebrew'
  if (
    bundle.startsWith('/Volumes/') ||
    bundle.includes('/AppTranslocation/') ||
    !writable(path.dirname(bundle))
  ) {
    return 'mac-readonly'
  }
  return __TAUT_MAC_SIGNING__.startsWith('adhoc:') ? 'mac-adhoc' : 'mac'
}

function aptRepo() {
  try {
    return readdirSync('/etc/apt/sources.list.d').some((f) => {
      try {
        const file = path.join('/etc/apt/sources.list.d', f)
        return readFileSync(file, 'utf8').includes('taut.jer.app/apt')
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

/** whether a package's file list (one path per line) has the running `exe` */
function listsExe(file: string, exe: string, relative = false) {
  try {
    const lines = new Set(readFileSync(file, 'utf8').split('\n'))
    return [exe, safeRealpath(exe)].some((p) =>
      lines.has(relative ? p.slice(1) : p)
    )
  } catch {
    return false
  }
}

async function linuxType(exe: string): Promise<TautInstallType> {
  // the AppImage runtime mounts the image at APPDIR, and children inherit both
  const appdir = process.env.APPDIR
  if (process.env.APPIMAGE && appdir && exe.startsWith(`${appdir}/`)) {
    return 'appimage'
  }
  if (listsExe('/var/lib/dpkg/info/taut.list', exe)) {
    return aptRepo() ? 'apt' : 'deb'
  }
  try {
    const local = '/var/lib/pacman/local'
    for (const dir of readdirSync(local)) {
      // its paths have no leading slash
      if (
        /^taut-\d/.test(dir) &&
        listsExe(path.join(local, dir, 'files'), exe, true)
      ) {
        return 'pacman'
      }
    }
  } catch {}
  try {
    const { stdout } = await run('rpm', ['-qf', '--qf', '%{NAME}', exe], {
      timeout: 5000,
    })
    if (stdout.trim() === 'taut') {
      return existsSync('/etc/yum.repos.d/taut.repo') ? 'dnf' : 'rpm'
    }
  } catch {}
  return 'unknown'
}

async function detectType(): Promise<TautInstallType> {
  if (__TAUT_EMBEDDED__) return 'embedded'
  if (!app.isPackaged) return 'dev'
  if (process.env.TAUT_TEMPORARY === '1') return 'temporary'
  const exe = process.execPath
  if (isNix(exe)) return 'nix'
  switch (process.platform) {
    case 'darwin':
      return macType(exe)
    case 'win32':
      // electron-builder's NSIS installer puts its uninstaller beside Taut.exe
      return existsSync(path.join(path.dirname(exe), 'Uninstall Taut.exe'))
        ? 'nsis'
        : 'unknown'
    default:
      return linuxType(exe)
  }
}

/** the arch of this machine's installer, arm64 even under x64 emulation */
export const installerArch = (): 'arm64' | 'x64' =>
  process.arch === 'arm64' || app.runningUnderARM64Translation ? 'arm64' : 'x64'

/** the installer for this machine, see installerArch */
export function installerPlatform(): TautDesktopPlatform {
  const arm = installerArch() === 'arm64'
  switch (process.platform) {
    case 'darwin':
      return arm ? 'mac' : 'mac-x64'
    case 'win32':
      return arm ? 'win-arm' : 'win'
    default:
      return arm ? 'linux-arm' : 'linux'
  }
}

let cached: Promise<TautInstall> | null = null

export function getInstall(): Promise<TautInstall> {
  cached ??= detectType()
    .catch((err): TautInstallType => {
      console.warn('[Taut] Install type detection failed:', err)
      return 'unknown'
    })
    .then((type) => {
      const install: TautInstall = {
        type,
        platform: installerPlatform(),
        canSelfUpdate:
          // the install types electron-updater updates in place
          ['nsis', 'mac', 'appimage'].includes(type) &&
          // an AppImage is replaced in place, next to itself
          (type !== 'appimage' ||
            writable(path.dirname(process.env.APPIMAGE ?? ''))),
      }
      console.log('[Taut] Install:', install)
      return install
    })
  return cached
}
