// reads the desktop release ledger from taut.jer.app (see server/src/desktop.ts)

import type { DesktopReleaseRecord } from '../../shared/updates.ts'

export const TAUT_SERVER = 'https://taut.jer.app'

export type DesktopRelease = Omit<DesktopReleaseRecord, 'feeds'>

/** newest first */
export async function desktopReleases(): Promise<DesktopRelease[]> {
  const response = await fetch(`${TAUT_SERVER}/api/desktop-releases`)
  if (!response.ok) {
    throw new Error(
      `${TAUT_SERVER}/api/desktop-releases: HTTP ${response.status}`
    )
  }
  return response.json() as Promise<DesktopRelease[]>
}

export function newestWith(releases: DesktopRelease[], name: string) {
  for (const release of releases) {
    const asset = release.assets[name]
    if (asset) return { release, asset }
  }
  return null
}
