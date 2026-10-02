// Taut Desktop AppImage integration

import { execFile } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// inside a quoted Exec argument these need a backslash
const quoteExecArg = (arg: string) => `"${arg.replace(/[\\"`$]/g, '\\$&')}"`

async function copyIcons(appDir: string, dataHome: string) {
  const iconsRoot = path.join(appDir, 'usr', 'share', 'icons', 'hicolor')
  const sizes = await readdir(iconsRoot)
  await Promise.all(
    sizes.map(async (size) => {
      const dest = path.join(dataHome, 'icons', 'hicolor', size, 'apps')
      await mkdir(dest, { recursive: true })
      await copyFile(
        path.join(iconsRoot, size, 'apps', 'taut.png'),
        path.join(dest, 'taut.png')
      )
    })
  )
}

/** resolves once the .desktop file is in place, or when there's nothing to do */
export async function installAppImageDesktopEntry(): Promise<void> {
  const { APPIMAGE, APPDIR } = process.env
  if (process.platform !== 'linux' || !APPIMAGE || !APPDIR) return

  const dataHome =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  const appsDir = path.join(dataHome, 'applications')
  try {
    const entry = (
      await readFile(path.join(APPDIR, 'taut.desktop'), 'utf8')
    ).replace(/^Exec=AppRun\b/m, `Exec=${quoteExecArg(APPIMAGE)}`)
    await mkdir(appsDir, { recursive: true })
    await writeFile(path.join(appsDir, 'taut.desktop'), entry)
  } catch (e) {
    console.error('[Taut] Failed to install desktop entry:', e)
    return
  }
  console.log(`[Taut] Installed ${appsDir}/taut.desktop for ${APPIMAGE}`)

  copyIcons(APPDIR, dataHome)
    .catch((e) => console.warn('[Taut] Failed to copy icons:', e))
    .then(() => run('update-desktop-database', [appsDir]).catch(() => {}))
}
