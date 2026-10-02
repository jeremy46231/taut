#!/usr/bin/env node

// Builds one user plugin into the format Taut's import UI accepts

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { bundlePlugin } from './lib/plugin.ts'

const [, , inputArg, outputArg] = process.argv
if (!inputArg) {
  console.error(
    'Usage: npm run build:user-plugin -- <plugin.ts|plugin.tsx> [output.js]'
  )
  process.exit(1)
}

const input = path.resolve(inputArg)
const parsed = path.parse(input)
const output = outputArg
  ? path.resolve(outputArg)
  : path.join(parsed.dir, `${parsed.name}.js`)

try {
  const code = await bundlePlugin(input)
  await writeFile(output, code)
  console.log(`[build-user-plugin] ${path.relative(process.cwd(), output)}`)
} catch (err) {
  console.error('[build-user-plugin] Build failed:', err)
  process.exit(1)
}
