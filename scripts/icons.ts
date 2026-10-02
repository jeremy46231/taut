#!/usr/bin/env node

// Optimizes the source logo in place and regenerates the derived icons

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { commandExists } from './lib/fs.ts'
import { ASSETS, SERVER } from './lib/paths.ts'

const asset = (...p: string[]) => path.join(ASSETS, ...p)
const toPng = (input: string | Buffer) =>
  sharp(input).png({ compressionLevel: 9, effort: 10 }).toBuffer()

await mkdir(asset('icons'), { recursive: true })

await writeFile(asset('logo.png'), await toPng(asset('logo.png')))

// extension icon sizes, plus the site's favicon and userscript icon
const logo = await readFile(asset('logo.png'))
for (const size of [16, 32, 48, 128]) {
  await writeFile(
    asset('icons', `icon-${size}.png`),
    await toPng(await sharp(logo).resize(size, size).toBuffer())
  )
}
await writeFile(path.join(SERVER, 'public', 'icon.png'), logo)

const MAC_ICON = asset('taut.icon')
if (commandExists('actool')) {
  const out = asset('icons', 'mac')
  const scratch = await mkdtemp(path.join(tmpdir(), 'taut-icons-'))
  await mkdir(out, { recursive: true })
  execFileSync(
    'actool',
    [
      '--compile',
      out,
      '--app-icon',
      path.basename(MAC_ICON, '.icon'),
      '--output-partial-info-plist',
      path.join(scratch, 'icon.plist'),
      '--platform',
      'macosx',
      '--minimum-deployment-target',
      '11.0',
      '--standalone-icon-behavior',
      'all',
      MAC_ICON,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )
  await rm(scratch, { recursive: true, force: true })
} else {
  console.log('[icons] No actool (needs Xcode on macOS), kept the macOS icon')
}

console.log('[icons] Done')
