// Taut Desktop Preferences

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomicWrite.js'
import { configDir } from './paths.js'

declare const __TAUT_EMBEDDED__: boolean

const DEFAULT_APP_URL = __TAUT_EMBEDDED__
  ? 'taut://app/taut.js'
  : 'https://taut.jer.app/taut.js'

function getPrefsPath(): string {
  return path.join(configDir(), 'prefs.json')
}

interface TautPrefs {
  appUrl?: string
  notifPrompted?: boolean
  signing?: string
}

let cached: TautPrefs | null = null

export async function loadPrefs(): Promise<TautPrefs> {
  let loaded: TautPrefs
  try {
    const text = await fs.readFile(getPrefsPath(), 'utf8')
    loaded = JSON.parse(text)
  } catch {
    loaded = {}
  }
  cached = loaded
  return loaded
}

export async function savePrefs(prefs: Partial<TautPrefs>): Promise<void> {
  cached = { ...cached, ...prefs }
  await writeFileAtomic(getPrefsPath(), JSON.stringify(cached, null, 2))
}

export function getAppUrl(): string {
  return cached?.appUrl ?? DEFAULT_APP_URL
}

export function getNotifPrompted(): boolean {
  return cached?.notifPrompted ?? false
}

export function getSigning(): string | undefined {
  return cached?.signing
}
