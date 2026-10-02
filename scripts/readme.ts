#!/usr/bin/env node

// Writes the plugin list and count in README.md from each plugin's static fields, usage: node scripts/readme.ts [--check]

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { AUTHORS, type Author } from '../shared/authors.ts'
import { PLUGINS, ROOT, SHARED } from './lib/paths.ts'

const README = path.join(ROOT, 'README.md')
const BEGIN = '<!-- begin plugins (written by scripts/readme.ts) -->'
const END = '<!-- end plugins -->'

type Meta = {
  name: string
  description: string
  category: string
  hackClubOnly: boolean
}

const parse = (file: string) =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)

/** PLUGIN_CATEGORIES from shared/Plugin.ts, read from source since Node can't run that file */
function readCategories(): [key: string, label: string][] {
  const categories: [string, string][] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'PLUGIN_CATEGORIES' &&
      node.initializer
    ) {
      let value = node.initializer
      if (ts.isAsExpression(value)) value = value.expression
      if (ts.isObjectLiteralExpression(value)) {
        for (const prop of value.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            ts.isStringLiteralLike(prop.initializer)
          )
            categories.push([prop.name.text, prop.initializer.text])
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(path.join(SHARED, 'Plugin.ts')))
  if (!categories.length)
    throw new Error('[readme] no PLUGIN_CATEGORIES in shared/Plugin.ts')
  return categories
}

/** the plugin class's static string and boolean fields */
function readMeta(file: string): Meta {
  const source = parse(file)
  const fields: Record<string, string | boolean> = {}
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.name) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
    ) {
      const value = node.initializer
      if (ts.isStringLiteralLike(value)) fields[node.name.text] = value.text
      else if (value.kind === ts.SyntaxKind.TrueKeyword)
        fields[node.name.text] = true
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const { pluginName, description } = fields
  if (typeof pluginName !== 'string' || typeof description !== 'string') {
    throw new Error(`[readme] ${file} has no static pluginName and description`)
  }
  return {
    name: pluginName,
    description,
    category: typeof fields.category === 'string' ? fields.category : '',
    hackClubOnly: fields.hackClubOnly === true,
  }
}

const authorsById = new Map<string, Author>()
for (const author of Object.values<Author>(AUTHORS))
  if (author.slackId) authorsById.set(author.slackId, author)

/** Slack mrkdwn links and mentions as Markdown */
function markdown(text: string): string {
  return text.replace(/<([^>|]+)(?:\|([^>]+))?>/g, (whole, target, label) => {
    if (target.startsWith('@')) {
      const author = authorsById.get(target.slice(1))
      if (!author) return whole
      return author.url ? `[${author.name}](${author.url})` : author.name
    }
    return label ? `[${label}](${target})` : target
  })
}

const plugins = readdirSync(PLUGINS)
  .filter((f) => /\.[tj]sx?$/.test(f) && !f.includes('.disabled.'))
  .map((f) => readMeta(path.join(PLUGINS, f)))

// grouped like the settings list (app/settings/pluginList.tsx)
const categories = readCategories()
const groups = new Map<string, Meta[]>()
for (const [key, label] of categories)
  groups.set(
    label,
    plugins.filter((p) => p.category === key)
  )
groups.set(
  'Other',
  plugins.filter((p) => !categories.some(([key]) => key === p.category))
)

const lines = [
  BEGIN,
  '',
  `<details><summary>All ${plugins.length} plugins</summary>`,
]
for (const [label, group] of groups) {
  if (!group.length) continue
  lines.push('', `#### ${label}`, '')
  for (const p of group.sort((a, b) => a.name.localeCompare(b.name))) {
    const only = p.hackClubOnly ? ' (Hack Club only)' : ''
    lines.push(`- **${p.name}**${only}: ${markdown(p.description)}`)
  }
}
lines.push('', '</details>', '', END)

const readme = readFileSync(README, 'utf8')
const start = readme.indexOf(BEGIN)
const end = readme.indexOf(END)
if (start === -1 || end < start) {
  throw new Error(`[readme] README.md has no "${BEGIN}" ... "${END}" block`)
}
// the Taut column of the comparison table's first row
const COUNT = /^(\| Plugins \| (?:\*\*)?)\d+((?:\*\*)? \|)/m
if (!COUNT.test(readme)) {
  throw new Error('[readme] README.md has no "| Plugins | <count> |" table row')
}
const next =
  `${readme.slice(0, start)}${lines.join('\n')}${readme.slice(end + END.length)}`.replace(
    COUNT,
    `$1${plugins.length}$2`
  )

if (next === readme) {
  console.log('[readme] already up to date')
} else if (process.argv.includes('--check')) {
  console.error(
    '[readme] the plugin list or count is out of date, run npm run readme'
  )
  process.exit(1)
} else {
  writeFileSync(README, next)
  console.log(`[readme] wrote ${plugins.length} plugins`)
}
