// Taut Desktop archive extraction

import { createRequire } from 'node:module'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Unzip, UnzipInflate } from 'fflate'
import tar from 'tar-stream'
import xz from 'xz-decompress'

// electron's fs treats any path ending in .asar as an archive, which breaks writing Slack's app.asar, original-fs doesn't
const cjsRequire = createRequire(import.meta.url)
const fs: typeof import('node:fs') = cjsRequire(
  process.versions.electron ? 'original-fs' : 'node:fs'
)
const { createReadStream, createWriteStream } = fs
const { mkdir, open, writeFile } = fs.promises

const withSlash = (dir: string) => dir.replace(/^\.\//, '').replace(/\/?$/, '/')

async function writeEntry(into: string, relative: string, data: Uint8Array) {
  const dest = path.join(into, relative)
  await mkdir(path.dirname(dest), { recursive: true })
  await writeFile(dest, data)
}

/** extracts the files under `dir` in a zip to `into/<rest>` */
export async function extractZipDir(
  archive: string,
  dir: string,
  into: string
) {
  const prefix = withSlash(dir)
  const writes: Promise<void>[] = []
  const unzip = new Unzip((file) => {
    if (!file.name.startsWith(prefix)) return
    if (file.name.endsWith('/')) {
      writes.push(
        mkdir(path.join(into, file.name.slice(prefix.length)), {
          recursive: true,
        }).then(() => {})
      )
      return
    }
    const chunks: Uint8Array[] = []
    writes.push(
      new Promise<void>((resolve, reject) => {
        file.ondata = (err, data, final) => {
          if (err) return reject(err)
          chunks.push(data)
          if (final) resolve()
        }
        file.start()
      }).then(() =>
        writeEntry(into, file.name.slice(prefix.length), Buffer.concat(chunks))
      )
    )
  })
  unzip.register(UnzipInflate)
  for await (const chunk of createReadStream(archive)) {
    unzip.push(chunk as Buffer, false)
  }
  unzip.push(new Uint8Array(0), true)
  await Promise.all(writes)
}

// a .deb is an ar archive: 8 byte magic, 60 byte headers (name at 0..16, decimal size at 48..58), members padded to even offsets
async function debDataMember(deb: string) {
  const file = await open(deb)
  try {
    const header = Buffer.alloc(60)
    let offset = 8
    for (;;) {
      const { bytesRead } = await file.read(header, 0, 60, offset)
      if (bytesRead < 60) throw new Error(`${deb}: no data.tar.xz member`)
      const name = header.toString('ascii', 0, 16).trim().replace(/\/$/, '')
      const size = Number(header.toString('ascii', 48, 58).trim())
      if (name === 'data.tar.xz') {
        return { start: offset + 60, end: offset + 60 + size - 1 }
      }
      offset += 60 + size + (size % 2)
    }
  } finally {
    await file.close()
  }
}

/** extracts the files under `dir` in a deb's data.tar.xz to `into` */
export async function extractDebDir(deb: string, dir: string, into: string) {
  const prefix = withSlash(dir)
  const { start, end } = await debDataMember(deb)
  const compressed = Readable.toWeb(
    createReadStream(deb, { start, end })
  ) as ReadableStream<Uint8Array>
  const plain = new xz.XzReadableStream(compressed)
  const extract = tar.extract()
  extract.on('entry', (header, stream, next) => {
    const name = header.name.replace(/^\.\//, '')
    if (header.type !== 'file' || !name.startsWith(prefix)) {
      stream.resume()
      stream.on('end', next)
      return
    }
    const dest = path.join(into, name.slice(prefix.length))
    mkdir(path.dirname(dest), { recursive: true })
      .then(() => pipeline(stream, createWriteStream(dest)))
      .then(
        () => next(),
        (err) => extract.destroy(err)
      )
  })
  await pipeline(Readable.fromWeb(plain as never), extract)
}
