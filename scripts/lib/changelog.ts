import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Change, Release } from '../../shared/changelog.ts'
import { compareVersions } from '../../shared/updates.ts'
import { PLUGINS, ROOT } from './paths.ts'

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

/** normalized id or display name -> plugin id, parsed from the source */
export function readPluginNames(): Map<string, string> {
  const names = new Map<string, string>()
  for (const file of readdirSync(PLUGINS)) {
    if (!/\.[tj]sx?$/.test(file)) continue
    const source = readFileSync(path.join(PLUGINS, file), 'utf8')
    const field = (name: string) =>
      source.match(
        new RegExp(
          `static\\s+(?:readonly\\s+)?${name}\\s*=\\s*(['"\`])(.+?)\\1`
        )
      )?.[2]
    const id = field('id') ?? file.split('.')[0]
    names.set(normalize(id), id)
    const display = field('pluginName')
    if (display) names.set(normalize(display), id)
  }
  return names
}

type ParsedRelease = Release & { lines: number[] }

/** `**Name** (new plugin): text` or `**Name**: text` */
const PLUGIN_ITEM = /^\*\*([^*]+)\*\*(\s*\(new plugin\))?:\s+(.+)$/i
const FIX = /^fix(?:ed|es)?\b/i

/** bullets are `**Plugin** (new plugin): text`, `**Plugin**: text` or `text`, a fix if the text starts with "Fixed" */
export function parseChangelog(markdown: string): ParsedRelease[] {
  const releases: ParsedRelease[] = []
  let current: ParsedRelease | null = null
  let last: Change | null = null
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const heading = line.match(/^##\s+v?(\d+\.\d+\.\d+)\b/)
    if (heading) {
      current = { version: heading[1], changes: [], lines: [] }
      releases.push(current)
      last = null
      continue
    }
    if (line.startsWith('#')) {
      current = null
      continue
    }
    if (!current) continue
    const item = line.match(/^[-*]\s+(.+)$/)
    if (item) {
      const body = item[1].trim()
      const plugin = body.match(PLUGIN_ITEM)
      if (plugin) {
        const [, name, isNew, text] = plugin
        last = {
          kind: isNew ? 'new' : FIX.test(text) ? 'fix' : 'plugin',
          pluginName: name.trim(),
          text: text.trim(),
        }
      } else {
        last = { kind: FIX.test(body) ? 'fix' : 'feature', text: body }
      }
      current.changes.push(last)
      current.lines.push(index + 1)
    } else if (last && /^\s{2,}\S/.test(line)) {
      // a bullet wrapped onto the next line
      last.text += ` ${line.trim()}`
    } else if (line.trim()) {
      last = null
    }
  }
  return releases
}

function resolvePlugins(releases: ParsedRelease[], names: Map<string, string>) {
  for (const release of releases) {
    release.changes.forEach((change, i) => {
      if (!change.pluginName) return
      const id = names.get(normalize(change.pluginName))
      if (!id) {
        throw new Error(
          `CHANGELOG.md:${release.lines[i]}: no plugin is called "${change.pluginName}". ` +
            'Use its name or id, or leave out the **bold**: prefix for a change to Taut itself'
        )
      }
      change.plugin = id
    })
  }
}

// newer releases are held back so they aren't announced early, but still checked
export function readChangelog(appVersion: string, limit = 8): Release[] {
  const releases = parseChangelog(
    readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
  )
  const ahead = releases.filter(
    (r) => compareVersions(r.version, appVersion) > 0
  )
  const shipped = releases
    .filter((r) => compareVersions(r.version, appVersion) <= 0)
    .slice(0, limit)
  resolvePlugins([...ahead, ...shipped], readPluginNames())
  for (const r of ahead) {
    console.log(
      `[changelog] ## ${r.version} is held back until package.json (${appVersion}) reaches it`
    )
  }
  return shipped.map(({ version, changes }) => ({ version, changes }))
}
