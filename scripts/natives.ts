#!/usr/bin/env node

// Builds the arm64 linux replacements for Slack's native modules, run on arm64 linux with a C++ toolchain, python3, libx11-dev and libxkbfile-dev

import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { nativesDir, SLACK_NATIVE_MODULES } from './lib/natives.ts'

if (process.platform !== 'linux' || process.arch !== 'arm64') {
  console.error('[natives] this only runs on arm64 linux')
  process.exit(1)
}

const out = nativesDir('linux-arm')
const work = await mkdtemp(path.join(os.tmpdir(), 'taut-natives-'))
try {
  await writeFile(
    path.join(work, 'package.json'),
    JSON.stringify({ name: 'taut-natives', private: true }, null, 2)
  )
  const specs = SLACK_NATIVE_MODULES.map((m) => `${m.package}@${m.version}`)
  console.log(`[natives] building ${specs.join(', ')}`)
  execFileSync(
    'npm',
    ['install', '--build-from-source', '--no-audit', '--no-fund', ...specs],
    { cwd: work, stdio: 'inherit' }
  )
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  for (const m of SLACK_NATIVE_MODULES) {
    await cp(
      path.join(work, 'node_modules', m.package, 'build', 'Release', m.file),
      path.join(out, m.file)
    )
    console.log(`[natives] ${path.relative(process.cwd(), out)}/${m.file}`)
  }
} finally {
  await rm(work, { recursive: true, force: true })
}
