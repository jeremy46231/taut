#!/usr/bin/env bun

import fs from 'node:fs'
import path from 'node:path'
import build from './buildTaut'

if (!('Bun' in globalThis)) {
  console.error('This script must be run with Bun.')
  process.exit(1)
}

const ROOT = path.join(import.meta.dir, '..')

let rebuildTimer: ReturnType<typeof setTimeout> | undefined
let currentBuild: Promise<void> | null = null
async function rebuild() {
  if (currentBuild) return currentBuild

  currentBuild = build(true).catch((err) => {
    console.error(
      '[serve-taut] Build failed, watching for changes...',
      err.message
    )
  })

  try {
    return await currentBuild
  } finally {
    currentBuild = null
  }
}

await rebuild()
for (const target of [
  path.join(ROOT, 'app'),
  path.join(ROOT, 'plugins'),
  path.join(ROOT, 'shared'),
  path.join(ROOT, 'package.json'),
])
  fs.watch(target, { recursive: true }, () => {
    if (rebuildTimer) clearTimeout(rebuildTimer)
    rebuildTimer = setTimeout(() => void rebuild(), 100)
  })

const server = Bun.serve({
  port: 3000,
  fetch(request) {
    const url = new URL(request.url)

    if (url.pathname !== '/taut.js')
      return new Response('Not found', { status: 404 })

    return new Response(
      fs.readFileSync(path.join(ROOT, 'dist', 'taut.debug.js')),
      {
        headers: {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-store',
        },
      }
    )
  },
})

console.log(`Listening on http://localhost:${server.port}/taut.js`)
