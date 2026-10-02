#!/usr/bin/env node

// Rebuilds the debug bundle on change and serves it on localhost:3000 (or $PORT)

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { buildTautBundle } from './build/taut.ts'
import { APP, PLUGINS, ROOT, SHARED, TAUT_DEBUG_JS } from './lib/paths.ts'

// served in place of the bundle so a failed build can't pass for the previous one
let buildError: string | null = null
let rebuildTimer: ReturnType<typeof setTimeout> | undefined
let building = false
// a change during a build, which that build may have missed
let rebuildQueued = false
async function rebuild() {
  if (building) {
    rebuildQueued = true
    return
  }
  building = true
  try {
    do {
      rebuildQueued = false
      await buildTautBundle(true, { telemetry: false }).then(
        () => {
          buildError = null
        },
        (err) => {
          buildError = String(err?.message ?? err)
          console.error(
            '[dev] Build failed, watching for changes...',
            buildError
          )
        }
      )
    } while (rebuildQueued)
  } finally {
    building = false
    watchLinkedPlugins()
  }
}

function scheduleRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => rebuild(), 100)
}

// fs.watch doesn't follow symlinks, so linked plugins are watched at their real path
const linkWatchers = new Map<string, fs.FSWatcher>()
function watchLinkedPlugins() {
  const targets = new Set<string>()
  for (const name of fs.readdirSync(PLUGINS)) {
    const file = path.join(PLUGINS, name)
    try {
      if (fs.lstatSync(file).isSymbolicLink())
        targets.add(fs.realpathSync(file))
    } catch {}
  }
  for (const [target, watcher] of linkWatchers) {
    if (targets.has(target)) continue
    watcher.close()
    linkWatchers.delete(target)
  }
  for (const target of targets) {
    if (linkWatchers.has(target)) continue
    try {
      // watch a file's directory, editors that save by replacing the file strand a watch on the file
      const name = path.basename(target)
      const watcher = fs.statSync(target).isDirectory()
        ? fs.watch(target, { recursive: true }, scheduleRebuild)
        : fs.watch(path.dirname(target), (_event, changed) => {
            if (changed === null || changed === name) scheduleRebuild()
          })
      // the next build watches it again
      watcher.on('error', () => {
        watcher.close()
        linkWatchers.delete(target)
      })
      linkWatchers.set(target, watcher)
    } catch {}
  }
}

await rebuild()
for (const target of [
  APP,
  PLUGINS,
  SHARED,
  path.join(ROOT, 'package.json'),
  path.join(ROOT, 'CHANGELOG.md'),
])
  fs.watch(target, { recursive: true }, scheduleRebuild)

const PORT = Number(process.env.PORT) || 3000
http
  .createServer((req, res) => {
    if (req.url !== '/taut.js') {
      res.writeHead(404).end('Not found')
      return
    }
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(
      buildError === null
        ? fs.readFileSync(TAUT_DEBUG_JS)
        : `console.error(${JSON.stringify(`[Taut] Dev server build failed, Taut isn't loaded:\n\n${buildError}`)})\n`
    )
  })
  .listen(PORT, () => {
    console.log(`Listening on http://localhost:${PORT}/taut.js`)
  })
