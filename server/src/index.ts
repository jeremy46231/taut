import type { VersionsFile } from '../../shared/updates'
import { desktopReleases, reportDesktopRelease, versionsFile } from './desktop'

interface Env {
  ASSETS: Fetcher
  DB: D1Database
  /** taut-versions.json without the desktop releases, from scripts/build/versions.ts */
  VERSIONS: string
}

const GH = 'https://github.com/jeremy46231/taut/releases/download'

// every release asset is named taut[.-something...].ext, see scripts/lib/artifacts.ts
const RELEASE_ASSET =
  /^\/taut(?:[.-][a-z0-9]+)*\.(?:js|json|zip|xpi|dmg|exe|AppImage|deb|rpm|pacman)$/

// an index is served from the same release as the packages it pins by hash (see scripts/repo.ts)
const REPO_ROUTES: Array<
  [
    RegExp,
    (m: RegExpMatchArray) => {
      asset: string
      version?: string
      index?: string
    },
  ]
> = [
  [
    /^\/apt\/dists\/stable\/(?:main\/binary-(\w+)\/)?([\w.]+)$/,
    (m) => ({
      asset: `apt-${m[1] ? `${m[1]}-` : ''}${m[2]}`,
      index: 'apt-InRelease',
    }),
  ],
  [
    /^\/apt\/pool\/([\d.]+)\/(taut-linux(?:-arm)?\.deb)$/,
    (m) => ({ asset: m[2], version: m[1] }),
  ],
  [
    /^\/rpm\/repodata\/([\w.-]+)$/,
    (m) => ({
      asset: `rpm-repodata-${m[1]}`,
      index: 'rpm-repodata-repomd.xml',
    }),
  ],
  [
    /^\/rpm\/([\d.]+)\/(taut-linux(?:-arm)?\.rpm)$/,
    (m) => ({ asset: m[2], version: m[1] }),
  ],
]

// see app/api/telemetry.ts
const PING_FIELDS = {
  install: /^[0-9a-f-]{36}$/,
  user: /^[UW][A-Z0-9]{8,12}$/,
  team: /^[TE][A-Z0-9]{8,12}$/,
  version: /^[\w.+-]{1,32}$/,
  loader: /^(electron|chrome-extension|firefox-extension|userscript)$/,
  loaderVersion: /^[\w.+-]{1,32}$/,
}

async function ping(request: Request, env: Env): Promise<Response> {
  const respond = (status: number, text = '') =>
    new Response(text || null, {
      status,
      headers: {
        'access-control-allow-origin': 'https://app.slack.com',
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type',
      },
    })
  if (request.method === 'OPTIONS') return respond(204)
  if (request.method !== 'POST') return respond(405)
  if (Number(request.headers.get('content-length')) > 2048) return respond(413)

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return respond(400, 'not json')
  }
  const fields: Record<string, string> = {}
  for (const [key, pattern] of Object.entries(PING_FIELDS)) {
    const value = body[key]
    if (typeof value !== 'string' || !pattern.test(value)) {
      return respond(400, `bad ${key}`)
    }
    fields[key] = value
  }
  const embedded =
    typeof body.embedded === 'boolean' ? Number(body.embedded) : null
  const os = typeof body.os === 'string' ? body.os.slice(0, 32) : null

  await env.DB.prepare(
    `insert or ignore into pings
       (day, install, user, team, version, loader, loader_version, embedded, os)
     values (date(), ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      fields.install,
      fields.user,
      fields.team,
      fields.version,
      fields.loader,
      fields.loaderVersion,
      embedded,
      os
    )
    .run()
  return respond(204)
}

const CACHED = {
  'Cache-Control': 'public, max-age=300',
  'Access-Control-Allow-Origin': '*',
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/') {
      return Response.redirect('https://github.com/jeremy46231/taut', 302)
    }

    if (path === '/ping') return ping(request, env)

    if (path === '/api/desktop-releases') {
      if (request.method === 'POST')
        return reportDesktopRelease(request, env.DB)
      const releases = await desktopReleases(env.DB)
      return Response.json(
        releases.map(({ feeds, ...release }) => release),
        { headers: { 'Cache-Control': 'no-store' } }
      )
    }

    if (path === '/taut-versions.json') {
      const base: VersionsFile = JSON.parse(env.VERSIONS)
      const file = versionsFile(base, await desktopReleases(env.DB))
      return Response.json(file, { headers: CACHED })
    }

    const feed = path.match(/^\/desktop\/([\w.-]+\.yml)$/)?.[1]
    if (feed) {
      const releases = await desktopReleases(env.DB)
      const text = releases.find((r) => r.feeds[feed])?.feeds[feed]
      // the updater takes a 404 as no update
      if (!text) return new Response('not found', { status: 404 })
      return new Response(text, {
        headers: { ...CACHED, 'Content-Type': 'text/yaml; charset=utf-8' },
      })
    }

    if (RELEASE_ASSET.test(path)) {
      const name = path.slice(1)
      const releases = await desktopReleases(env.DB)
      const asset = releases.find((r) => r.assets[name])?.assets[name]
      return Response.redirect(asset?.url ?? `${GH}/latest/${name}`, 302)
    }

    // the package paths in the `repo` release's indexes, from an older version
    // todo: remove once this is no longer needed
    const legacy = path.match(
      /^\/(?:apt\/pool|rpm)\/(taut-linux(?:-arm)?\.(?:deb|rpm))$/
    )?.[1]
    if (legacy) return Response.redirect(`${GH}/latest/${legacy}`, 302)

    for (const [pattern, route] of REPO_ROUTES) {
      const match = path.match(pattern)
      if (!match) continue
      const { asset, version, index } = route(match)
      const releases = await desktopReleases(env.DB)
      const release = releases.find((r) =>
        version ? r.version === version : r.assets[index ?? asset]
      )
      // until a release in the ledger has an index, serve one from github
      // todo: can we remove this when it's no longer needed?
      if (!release && index)
        return Response.redirect(`${GH}/repo/${asset}`, 302)
      const found = release?.assets[asset]
      if (!found) return new Response('not found', { status: 404 })
      return Response.redirect(found.url, 302)
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
