#!/usr/bin/env node

import { execFile as execFileCb } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { commandExists, findCommand } from './lib/fs.ts'
import { DIST } from './lib/paths.ts'
import { versions } from './lib/versions.ts'

const execFile = promisify(execFileCb)

const OUT = path.join(DIST, 'repo')
/** uid of the key imported into gpg, the matching public key is server/public/taut.asc */
const SIGNING_KEY = process.env.TAUT_REPO_SIGNING_KEY ?? 'Taut Package Signing'

const run = async (cmd: string, args: string[]) =>
  (await execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 })).stdout

const gpg = (args: string[]) =>
  run('gpg', ['--batch', '--yes', '--local-user', SIGNING_KEY, ...args])

const hashes = (data: Buffer) => ({
  md5: createHash('md5').update(data).digest('hex'),
  sha1: createHash('sha1').update(data).digest('hex'),
  sha256: createHash('sha256').update(data).digest('hex'),
})

async function installers(ext: string) {
  const dir = path.join(DIST, 'desktop')
  return (await readdir(dir))
    .filter((f) => f.endsWith(`.${ext}`))
    .map((f) => path.join(dir, f))
}

// apt: dists/stable/{InRelease,Release,Release.gpg,main/binary-<arch>/Packages[.gz]} with the .debs at pool/<version>/<name>

async function buildApt(debs: string[]) {
  const byArch = new Map<string, string[]>()
  for (const deb of debs) {
    const control = (await run('dpkg-deb', ['-f', deb])).trimEnd()
    const arch = /^Architecture: (\S+)/m.exec(control)?.[1]
    if (!arch) throw new Error(`${deb}: no Architecture in control`)
    const data = await readFile(deb)
    const h = hashes(data)
    const entry = [
      control,
      `Filename: pool/${versions.desktop}/${path.basename(deb)}`,
      `Size: ${data.byteLength}`,
      `MD5sum: ${h.md5}`,
      `SHA1: ${h.sha1}`,
      `SHA256: ${h.sha256}`,
    ].join('\n')
    byArch.set(arch, [...(byArch.get(arch) ?? []), entry])
  }

  const indexes: Array<{ relPath: string; data: Buffer }> = []
  for (const [arch, entries] of byArch) {
    const packages = Buffer.from(`${entries.join('\n\n')}\n`)
    const rel = `main/binary-${arch}/Packages`
    indexes.push({ relPath: rel, data: packages })
    indexes.push({ relPath: `${rel}.gz`, data: gzipSync(packages) })
    await writeFile(path.join(OUT, `apt-${arch}-Packages`), packages)
    await writeFile(
      path.join(OUT, `apt-${arch}-Packages.gz`),
      indexes[indexes.length - 1].data
    )
  }

  const sums = (algo: 'md5' | 'sha1' | 'sha256') =>
    indexes
      .map(
        ({ relPath, data }) =>
          ` ${hashes(data)[algo]} ${data.byteLength} ${relPath}`
      )
      .join('\n')
  const release = [
    'Origin: Taut',
    'Label: Taut',
    'Suite: stable',
    'Codename: stable',
    `Architectures: ${[...byArch.keys()].join(' ')}`,
    'Components: main',
    'Description: Taut, a client mod for Slack',
    `Date: ${new Date().toUTCString()}`,
    'MD5Sum:',
    sums('md5'),
    'SHA1:',
    sums('sha1'),
    'SHA256:',
    sums('sha256'),
    '',
  ].join('\n')
  const releaseFile = path.join(OUT, 'apt-Release')
  await writeFile(releaseFile, release)
  await gpg(['--clearsign', '-o', path.join(OUT, 'apt-InRelease'), releaseFile])
  await gpg([
    '--detach-sign',
    '--armor',
    '-o',
    path.join(OUT, 'apt-Release.gpg'),
    releaseFile,
  ])
  console.log(
    `[repo] apt: ${debs.length} packages, ${byArch.size} architectures`
  )
}

// dnf: repodata/* from createrepo_c over the .rpms at <version>/<name>, each signed in place first

async function buildRpm(rpms: string[]) {
  const work = path.join(OUT, 'rpm-work')
  await mkdir(path.join(work, versions.desktop), { recursive: true })
  const gpgPath = findCommand('gpg')
  for (const rpm of rpms) {
    await run('rpmsign', [
      '--define',
      `__gpg ${gpgPath}`,
      '--define',
      `_gpg_name ${SIGNING_KEY}`,
      '--addsign',
      rpm,
    ])
    await cp(rpm, path.join(work, versions.desktop, path.basename(rpm)))
  }
  await run('createrepo_c', ['--no-database', work])
  const repodata = path.join(work, 'repodata')
  await gpg(['--detach-sign', '--armor', path.join(repodata, 'repomd.xml')])
  for (const file of await readdir(repodata)) {
    await cp(path.join(repodata, file), path.join(OUT, `rpm-repodata-${file}`))
  }
  await rm(work, { recursive: true, force: true })
  console.log(`[repo] rpm: ${rpms.length} packages signed, repodata written`)
}

const [debs, rpms] = await Promise.all([installers('deb'), installers('rpm')])
if (debs.length === 0 && rpms.length === 0) {
  console.error(
    '[repo] no .deb or .rpm files in dist/desktop, build desktop linux first'
  )
  process.exit(1)
}
const needed = [
  'gpg',
  ...(debs.length ? ['dpkg-deb'] : []),
  ...(rpms.length ? ['rpmsign', 'createrepo_c'] : []),
]
for (const tool of needed) {
  if (!commandExists(tool)) {
    console.error(`[repo] ${tool} is required (linux only)`)
    process.exit(1)
  }
}
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
if (debs.length) await buildApt(debs)
if (rpms.length) await buildRpm(rpms)
for (const f of (await readdir(OUT)).sort()) {
  console.log(
    `[repo] dist/repo/${f} (${(await stat(path.join(OUT, f))).size} bytes)`
  )
}
