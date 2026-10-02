// anything not staged falls through to the Worker, see server/src/index.ts

import { existsSync } from 'node:fs'
import { cp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DIST, SERVER, TAUT_DEBUG_JS, TAUT_JS } from '../lib/paths.ts'

const OUT = path.join(DIST, 'server')
const EXTENSION_DIST = path.join(DIST, 'extension')
// only CI has the signed Firefox files, see .github/workflows/release.yml
const FIREFOX_SIGNED = path.join(EXTENSION_DIST, 'signed')

// revalidate every load, 304 via the automatic ETag
const REVALIDATE = 'public, max-age=0, must-revalidate'
const SCRIPT_HEADERS = {
  'Cache-Control': REVALIDATE,
  'X-Content-Type-Options': 'nosniff',
  'Access-Control-Allow-Origin': '*',
}

interface StagedFile {
  from: string
  headers: Record<string, string>
  /** leave it to the GitHub redirect when missing instead of failing */
  optional?: boolean
}

const FILES: Record<string, StagedFile> = {
  'taut.js': { from: TAUT_JS, headers: SCRIPT_HEADERS },
  'taut.debug.js': { from: TAUT_DEBUG_JS, headers: SCRIPT_HEADERS },
  'taut.user.js': {
    from: path.join(DIST, 'userscript', 'taut.user.js'),
    headers: SCRIPT_HEADERS,
  },
  'taut-chrome.zip': {
    from: path.join(EXTENSION_DIST, 'taut-chrome.zip'),
    headers: {
      'Cache-Control': REVALIDATE,
      'Content-Disposition': 'attachment; filename="taut-chrome.zip"',
    },
  },
  // the unsigned dist/extension/taut-firefox.xpi must never be served
  'taut-firefox.xpi': {
    from: path.join(FIREFOX_SIGNED, 'taut-firefox.xpi'),
    headers: {
      'Cache-Control': REVALIDATE,
      'Content-Type': 'application/x-xpinstall',
    },
    optional: true,
  },
  'taut-firefox-updates.json': {
    from: path.join(FIREFOX_SIGNED, 'taut-firefox-updates.json'),
    headers: { 'Cache-Control': 'public, max-age=300' },
    optional: true,
  },
}

export async function buildServer() {
  const missing = Object.entries(FILES)
    .filter(([, f]) => !f.optional && !existsSync(f.from))
    .map(([, f]) => path.relative(DIST, f.from))
  if (missing.length > 0) {
    throw new Error(
      `[build-server] missing ${missing.join(', ')}, run \`npm run build\` first`
    )
  }

  await rm(OUT, { recursive: true, force: true })
  await cp(path.join(SERVER, 'public'), OUT, { recursive: true })

  let headers = ''
  for (const [name, file] of Object.entries(FILES)) {
    if (!existsSync(file.from)) {
      console.log(`[build-server] ${name}: not staged, redirects to GitHub`)
      continue
    }
    await cp(file.from, path.join(OUT, name))
    headers += `/${name}\n`
    for (const [key, value] of Object.entries(file.headers)) {
      headers += `  ${key}: ${value}\n`
    }
  }
  await writeFile(path.join(OUT, '_headers'), headers)

  console.log('[build-server] dist/server')
}
