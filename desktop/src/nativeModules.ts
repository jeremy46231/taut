// Taut Desktop native modules: redirects the .node files Slack loads from app.asar.unpacked when its own copies can't load

import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { configDir } from './paths.js'

const NodeModule = createRequire(import.meta.url)('module') as any

// captured before patch.ts points resourcesPath at slack's
const realResourcesPath = process.resourcesPath

type NodeLoader = (module: any, filename: string) => void

function wrapNodeLoader(pick: (filename: string) => string) {
  const orig: NodeLoader = NodeModule._extensions['.node']
  NodeModule._extensions['.node'] = function (module: any, filename: string) {
    return orig.call(this, module, pick(filename))
  }
}

// msix Slack's addons in WindowsApps are readable but only Slack.exe can execute them, so load copies
function stageWindowsApps() {
  const programFiles = process.env.ProgramFiles ?? process.env.ProgramW6432
  if (!programFiles) return
  const windowsApps = path.join(programFiles, 'WindowsApps').toLowerCase()
  wrapNodeLoader((filename) => {
    if (!filename.toLowerCase().startsWith(windowsApps)) return filename
    const cacheDir = path.join(
      configDir(),
      'native-cache',
      createHash('sha1').update(filename).digest('hex').slice(0, 16)
    )
    const cachedFile = path.join(cacheDir, path.basename(filename))
    if (!existsSync(cachedFile)) {
      mkdirSync(cacheDir, { recursive: true })
      const srcDir = path.dirname(filename)
      for (const name of readdirSync(srcDir)) {
        const srcFile = path.join(srcDir, name)
        if (!statSync(srcFile).isFile()) continue
        copyFileSync(srcFile, path.join(cacheDir, name))
      }
      console.log(`[Taut] Staged WindowsApps native module: ${filename}`)
    }
    return cachedFile
  })
}

export const downloadedNativesDir = (slackResourcesPath: string) =>
  path.join(slackResourcesPath, 'taut-native')

// Slack only ships x64 linux natives, on arm64 use the prebuilds downloaded with Slack or the ones the build carries (scripts/lib/natives.ts)
function swapLinuxArm64(slackResourcesPath: string) {
  const dirs = [
    downloadedNativesDir(slackResourcesPath),
    path.join(realResourcesPath, 'native'),
  ]
  wrapNodeLoader((filename) => {
    if (!filename.startsWith(slackResourcesPath)) return filename
    const name = path.basename(filename)
    for (const dir of dirs) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) {
        console.log(`[Taut] Loading arm64 ${name} from ${dir}`)
        return candidate
      }
    }
    console.warn(
      `[Taut] No arm64 build of ${name}, Slack's x64 copy will fail to load`
    )
    return filename
  })
}

export function redirectNativeModules(slackResourcesPath: string) {
  if (process.platform === 'win32') stageWindowsApps()
  if (process.platform === 'linux' && process.arch === 'arm64') {
    swapLinuxArm64(slackResourcesPath)
  }
}

export type Arch = 'x64' | 'arm64'

const MACHO_CPU = new Map<number, Arch>([
  [0x01000007, 'x64'],
  [0x0100000c, 'arm64'],
])
const ELF_MACHINE = new Map<number, Arch>([
  [0x3e, 'x64'],
  [0xb7, 'arm64'],
])
const PE_MACHINE = new Map<number, Arch>([
  [0x8664, 'x64'],
  [0xaa64, 'arm64'],
])

/** the arches a native module's Mach-O, ELF or PE header says it runs on */
function nodeFileArches(file: string): Arch[] {
  const head = Buffer.alloc(4096)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, head, 0, head.length, 0)
  } finally {
    closeSync(fd)
  }
  const magic = head.readUInt32BE(0)
  let found: (Arch | undefined)[] = []
  if (magic === 0x7f454c46) found = [ELF_MACHINE.get(head.readUInt16LE(18))]
  else if (magic === 0xcffaedfe) found = [MACHO_CPU.get(head.readUInt32LE(4))]
  else if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const size = magic === 0xcafebabe ? 20 : 32
    const count = Math.min(head.readUInt32BE(4), 16)
    for (let i = 0; i < count; i++) {
      found.push(MACHO_CPU.get(head.readUInt32BE(8 + i * size)))
    }
  } else if (head.readUInt16LE(0) === 0x5a4d) {
    found = [PE_MACHINE.get(head.readUInt16LE(head.readUInt32LE(0x3c) + 4))]
  }
  return found.filter((arch) => arch !== undefined)
}

/** the arches all of a Slack's native modules run on, undefined when none could be read */
export function slackNativeArches(
  slackResourcesPath: string
): Set<Arch> | undefined {
  const unpacked = path.join(slackResourcesPath, 'app.asar.unpacked')
  let files: string[]
  try {
    files = readdirSync(unpacked, { recursive: true, encoding: 'utf8' })
  } catch {
    return undefined
  }
  let arches: Set<Arch> | undefined
  for (const file of files) {
    if (!file.endsWith('.node')) continue
    let found: Arch[]
    try {
      found = nodeFileArches(path.join(unpacked, file))
    } catch {
      continue
    }
    if (found.length === 0) continue
    const previous = arches
    arches = new Set(previous ? found.filter((a) => previous.has(a)) : found)
  }
  return arches
}
