#!/usr/bin/env bun

// Builds one user plugin into the format accepted by Taut's import UI.

import path from 'node:path'
import { bundlePlugin } from './pluginBuild'

const [, , inputArg, outputArg] = process.argv
if (!inputArg) {
  console.error(
    'Usage: bun run build:user-plugin <plugin.ts|plugin.tsx> [output.js]'
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
  await Bun.write(output, code)
  console.log(`[build-user-plugin] ${path.relative(process.cwd(), output)}`)
} catch (err) {
  console.error('[build-user-plugin] Build failed:', err)
  process.exit(1)
}
