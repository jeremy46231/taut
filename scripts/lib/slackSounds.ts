import { execFileSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { DESKTOP } from './paths.ts'
import { versions } from './versions.ts'

// macos finds a notification's sound by file name in the app bundle's Resources, so the mac build ships the pinned Slack's mp3s there
export const soundsDir = () => path.join(DESKTOP, 'sounds', versions.slack)

/** pulls the pinned Slack's notification mp3s into soundsDir(), downloading once */
export async function ensureSlackSounds(): Promise<string> {
  const dir = soundsDir()
  const have = await readdir(dir).catch(() => [] as string[])
  if (have.some((f) => f.endsWith('.mp3'))) return dir

  const v = versions.slack
  const url = `https://downloads.slack-edge.com/desktop-releases/mac/arm64/${v}/Slack-${v}-macOS.zip`
  const work = await mkdtemp(path.join(os.tmpdir(), 'taut-slack-sounds-'))
  try {
    console.log(`[slack-sounds] Downloading ${url}`)
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`)
    const zip = path.join(work, 'slack.zip')
    await pipeline(
      Readable.fromWeb(res.body as ReadableStream),
      createWriteStream(zip)
    )
    const sounds = path.join(work, 'sounds')
    execFileSync(
      'unzip',
      ['-q', '-j', zip, 'Slack.app/Contents/Resources/*.mp3', '-d', sounds],
      { stdio: 'inherit' }
    )
    const mp3s = (await readdir(sounds)).filter((f) => f.endsWith('.mp3'))
    if (mp3s.length === 0) {
      throw new Error(
        `${url} has no .mp3 files in Slack.app/Contents/Resources`
      )
    }
    await rm(dir, { recursive: true, force: true })
    await mkdir(path.dirname(dir), { recursive: true })
    await rename(sounds, dir)
    console.log(
      `[slack-sounds] ${mp3s.length} sounds in ${path.relative(process.cwd(), dir)}`
    )
    return dir
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
