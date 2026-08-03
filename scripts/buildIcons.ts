#!/usr/bin/env bun

// Optimizes the source logos in place and regenerates the derived icons

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const ROOT = path.join(import.meta.dir, '..')
const asset = (...p: string[]) => path.join(ROOT, 'assets', ...p)
const toPng = (input: string | Buffer) =>
  sharp(input).png({ compressionLevel: 9, effort: 10 }).toBuffer()

await mkdir(asset('icons'), { recursive: true })

// Optimize both source logos in place
for (const name of ['logo.png', 'logo-macos.png']) {
  await Bun.write(asset(name), await toPng(asset(name)))
}

// Extension icon sizes from the logo, plus the served favicon / userscript icon
const logo = Buffer.from(await Bun.file(asset('logo.png')).arrayBuffer())
for (const size of [16, 32, 48, 128]) {
  await Bun.write(
    asset('icons', `icon-${size}.png`),
    await toPng(await sharp(logo).resize(size, size).toBuffer())
  )
}
await Bun.write(path.join(ROOT, 'server', 'public', 'icon.png'), logo)

console.log('[build-icons] Done')
