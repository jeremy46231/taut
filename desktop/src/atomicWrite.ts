// Taut Desktop atomic file writes

import { promises as fs } from 'node:fs'
import path from 'node:path'

const queues = new Map<string, Promise<void>>()
let counter = 0

// on windows a rename over a file that antivirus or the indexer has open fails for a moment
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])

async function replace(temp: string, file: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fs.rename(temp, file)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || !BUSY.has(code) || attempt > 10) {
        throw err
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 20))
    }
  }
}

async function write(file: string, data: string | Uint8Array) {
  // a symlinked file stays a symlink
  const target = await fs.realpath(file).catch(() => file)
  // the watchers in bridge.ts ignore this name
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${counter++}.tmp`
  )
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(temp, data)
    await replace(temp, target)
  } catch (err) {
    await fs.rm(temp, { force: true })
    throw err
  }
}

/** writes a temp file and renames it over `file`, so readers never see a partial file, in call order per file */
export function writeFileAtomic(
  file: string,
  data: string | Uint8Array
): Promise<void> {
  const queued = (queues.get(file) ?? Promise.resolve())
    .catch(() => {})
    .then(() => write(file, data))
  queues.set(file, queued)
  const settled = () => {
    if (queues.get(file) === queued) queues.delete(file)
  }
  queued.then(settled, settled)
  return queued
}
