// the desktop release ledger, written by the desktop legs of .github/workflows/release.yml

import type { DesktopReleaseRecord, VersionsFile } from '../../shared/updates'
import { compareVersions } from '../../shared/updates'
import { checkReleaseToken } from './oidc'

export async function desktopReleases(
  db: D1Database
): Promise<DesktopReleaseRecord[]> {
  const { results } = await db
    .prepare('select version, assets, platforms, feeds from desktop_releases')
    .all<Record<keyof DesktopReleaseRecord, string>>()
  return results
    .map((row) => ({
      version: row.version,
      assets: JSON.parse(row.assets),
      platforms: JSON.parse(row.platforms),
      feeds: JSON.parse(row.feeds),
    }))
    .sort((a, b) => compareVersions(b.version, a.version))
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** returns why a report is invalid, or null if it's valid */
function checkReport(body: unknown): string | null {
  if (!isObject(body)) return 'not an object'
  const { version, assets, platforms, feeds } = body
  if (typeof version !== 'string' || !/^\d+(\.\d+)*$/.test(version))
    return 'bad version'
  if (!isObject(assets) || !isObject(platforms) || !isObject(feeds))
    return 'assets, platforms and feeds must be objects'
  const release = `https://github.com/jeremy46231/taut/releases/download/desktop-v${version}/`
  for (const [name, asset] of Object.entries(assets)) {
    if (
      !isObject(asset) ||
      asset.url !== release + name ||
      typeof asset.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(asset.sha256) ||
      typeof asset.size !== 'number'
    )
      return `bad asset ${name}`
  }
  for (const [key, files] of Object.entries(platforms)) {
    if (
      !isObject(files) ||
      !Object.values(files).every(
        (file) =>
          isObject(file) &&
          typeof file.url === 'string' &&
          file.url.startsWith(release)
      )
    )
      return `bad platform ${key}`
  }
  if (!Object.values(feeds).every((feed) => typeof feed === 'string'))
    return 'feeds must be text'
  return null
}

/** handles POST /api/desktop-releases, merging the report into that version's record */
export async function reportDesktopRelease(
  request: Request,
  db: D1Database
): Promise<Response> {
  const denied = await checkReleaseToken(request.headers.get('authorization'))
  if (denied) return new Response(denied, { status: 401 })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('not json', { status: 400 })
  }
  const problem = checkReport(body)
  if (problem) return new Response(problem, { status: 400 })
  const { version, assets, platforms, feeds } = body as DesktopReleaseRecord
  // a single upsert, so concurrent reports can't drop each other's files
  await db
    .prepare(
      `insert into desktop_releases (version, assets, platforms, feeds, updated)
       values (?, ?, ?, ?, datetime())
       on conflict (version) do update set
         assets = json_patch(assets, excluded.assets),
         platforms = json_patch(platforms, excluded.platforms),
         feeds = json_patch(feeds, excluded.feeds),
         updated = excluded.updated`
    )
    .bind(
      version,
      JSON.stringify(assets),
      JSON.stringify(platforms),
      JSON.stringify(feeds)
    )
    .run()
  return new Response(null, { status: 204 })
}

/** `base` with each platform's newest desktop release filled in */
export function versionsFile(
  base: VersionsFile,
  releases: DesktopReleaseRecord[]
): VersionsFile {
  const platforms: VersionsFile['loaders']['electron']['platforms'] = {}
  for (const { version, platforms: published } of releases) {
    for (const [key, files] of Object.entries(published)) {
      platforms[key as keyof typeof published] ??= { version, files }
    }
  }
  const latest =
    Object.values(platforms)
      .map((p) => p.version)
      .sort(compareVersions)
      .pop() ?? null
  return {
    ...base,
    loaders: {
      ...base.loaders,
      electron: { ...base.loaders.electron, latest, platforms },
    },
  }
}
