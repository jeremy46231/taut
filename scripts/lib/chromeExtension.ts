import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { EXTENSION } from './paths.ts'

export function chromeExtensionId(): string {
  const manifest = JSON.parse(
    readFileSync(path.join(EXTENSION, 'chrome', 'manifest.json'), 'utf8')
  )
  const hex = createHash('sha256')
    .update(Buffer.from(manifest.key, 'base64'))
    .digest('hex')
    .slice(0, 32)
  return [...hex]
    .map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
    .join('')
}
