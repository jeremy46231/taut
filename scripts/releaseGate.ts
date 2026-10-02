#!/usr/bin/env node

// Release gate: what a push releases, by version raises since the commit the `latest` tag was published from

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { compareVersions } from '../shared/updates.ts'

function git(...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

function output(values: Record<string, boolean>) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`)
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  console.log(lines.join(' '))
}

const sha = process.env.GITHUB_SHA || git('rev-parse', 'HEAD') || ''
const latest = git('rev-parse', '-q', '--verify', 'refs/tags/latest^{commit}')

// a stale run: the newer commit `latest` is on already released everything here
if (
  latest &&
  latest !== sha &&
  git('merge-base', '--is-ancestor', sha, latest) !== undefined
) {
  console.log(
    `::notice::latest is on the newer ${latest.slice(0, 7)}, which already has this commit's changes`
  )
  output({ taut: false, desktop: false, publish: false })
  process.exit(0)
}

const base = latest ? git('merge-base', sha, latest) : undefined

function version(commit: string, file: string): string | undefined {
  try {
    const { version } = JSON.parse(git('show', `${commit}:${file}`) ?? '')
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/** a file's `version` is higher than at base, or the file is new */
const raised = (...files: string[]) =>
  !base ||
  files.some((file) => {
    const next = version(sha, file)
    const old = version(base, file)
    return (
      next !== undefined &&
      (old === undefined || compareVersions(next, old) > 0)
    )
  })

// recommended.json files have no version, so any change counts
const changed = (...files: string[]) =>
  !base || !!git('log', '-1', '--format=%H', `${base}..${sha}`, '--', ...files)

const forced = (name: string) => process.env[name] === 'true'

const taut =
  forced('FORCE_TAUT') ||
  raised(
    'package.json',
    'extension/chrome/manifest.json',
    'extension/firefox/manifest.json',
    'userscript/version.json'
  )
const desktop = forced('FORCE_DESKTOP') || raised('desktop/package.json')
const versions =
  forced('FORCE_PUBLISH') ||
  changed(
    'desktop/recommended.json',
    'extension/chrome/recommended.json',
    'extension/firefox/recommended.json',
    'userscript/recommended.json'
  )

console.log(`since ${base ?? 'the start'}: versions=${versions}`)
output({ taut, desktop, publish: taut || desktop || versions })
