// Taut Desktop dev instance: runs the app in its own config dir beside a normal install, with its log, process tree and a CDP session

import { type ChildProcess, spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { buildDesktopJs } from '../build/desktop.ts'
import { DESKTOP, ROOT, TAUT_DEBUG_JS, TAUT_JS } from './paths.ts'

export const instanceRoot = (name: string) =>
  path.join(os.homedir(), '.taut-dev', name)

export function realConfigDir(): string {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Taut')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    return path.join(appData, 'Taut')
  }
  const config = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config')
  return path.join(config, 'Taut')
}

// <config>/profile since desktop v3, Slack's <appData>/Slack before, and of the two the fresher cookie jar is in use
export function realProfileDir(): string {
  const candidates = [
    path.join(realConfigDir(), 'profile'),
    path.join(path.dirname(realConfigDir()), 'Slack'),
  ]
  const best = candidates
    .map((dir) => {
      try {
        return { dir, mtime: statSync(path.join(dir, 'Cookies')).mtimeMs }
      } catch {
        return { dir, mtime: 0 }
      }
    })
    .sort((a, b) => b.mtime - a.mtime)[0]
  return best.mtime ? best.dir : candidates[0]
}

const SKIP_SEED = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Shared Dictionary',
  'Service Worker',
  'component_crx_cache',
  'blob_storage',
  'Crashpad',
  'sentry',
  'logs',
  'slack',
  'profile',
  'DIPS-wal',
  'secrets.dat',
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  '.DS_Store',
])

async function copyTree(from: string, to: string) {
  let entries = 0
  await cp(from, to, {
    recursive: true,
    force: true,
    filter: (src) => {
      if (src !== from && SKIP_SEED.has(path.basename(src))) return false
      entries++
      return true
    },
  })
  return entries
}

/** copies enough of the real install, minus caches, to start signed in */
export async function seedInstance(root: string) {
  const config = realConfigDir()
  if (!existsSync(config)) throw new Error(`nothing to seed from at ${config}`)
  const profile = realProfileDir()
  return (
    (await copyTree(config, path.join(root, 'config'))) +
    (existsSync(profile)
      ? await copyTree(profile, path.join(root, 'config', 'profile'))
      : 0)
  )
}

export const resetInstance = (root: string) =>
  rm(root, { recursive: true, force: true })

const URL_PRESETS: Record<string, string> = {
  dev: 'http://localhost:3000/taut.js',
  official: 'https://taut.jer.app/taut.js',
}

/** served to the instance from an ephemeral localhost server */
const SERVED: Record<string, () => Buffer | string> = {
  none: () => '/* no taut */\n',
  local: () => readFileSync(TAUT_JS),
  debug: () => readFileSync(TAUT_DEBUG_JS),
}

export const URL_SPECS = [...Object.keys(SERVED), ...Object.keys(URL_PRESETS)]

async function serveBundle(name: string) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(SERVED[name]())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://localhost:${port}/${name}.js`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function writeAppUrl(configDir: string, appUrl: string) {
  const file = path.join(configDir, 'prefs.json')
  const prefs = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'))
  prefs.appUrl = appUrl
  // the notification prompt steals focus on a fresh instance's first launch
  prefs.notifPrompted = true
  await writeFile(file, `${JSON.stringify(prefs, null, 2)}\n`)
}

export async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 200; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net
        .createServer()
        .once('error', () => resolve(false))
        .once('listening', () => server.close(() => resolve(true)))
        .listen(port, '127.0.0.1')
    })
    if (free) return port
  }
  throw new Error(`no free port near ${from}`)
}

export interface InstanceOptions {
  /** instance name under ~/.taut-dev (default: dev) */
  name?: string
  /** an absolute instance root, instead of a name */
  root?: string
  /** a URL_SPECS name or a URL, leaves prefs.json alone when unset */
  url?: string
  /** copy the real install's config and profile in first */
  seed?: boolean
  /** delete the instance before launching */
  reset?: boolean
  /** default: the first free port from 9222 */
  cdpPort?: number
  /** node inspector for the main process, 0 leaves it closed */
  inspectPort?: number
  /** mirror the log to this process's stdout (default true) */
  echo?: boolean
  /** keep the app off the foreground: no dock icon, never focused, transparent */
  background?: boolean
  /** register slack:// and the desktop entry, as a real install does */
  systemInstall?: boolean
  /** runs against each target while it's paused at its first statement, the only way to get ahead of the page's own scripts */
  onAttach?: (page: Page) => unknown
}

export interface LogLine {
  /** ms after exec */
  ms: number
  text: string
}

export interface ProcessSample {
  pid: number
  /** browser, renderer, gpu-process, utility */
  type: string
  rssKb: number
  cpuSeconds: number
}

export interface Instance {
  root: string
  configDir: string
  cdpPort: number
  inspectPort: number
  logPath: string
  pid: number
  /** Date.now() immediately before exec, the zero of every measurement */
  startedAt: number
  /** ms since exec */
  elapsed(): number
  exited: Promise<number>
  alive(): boolean
  /** browser-level connection, every target attached to it */
  cdp: Cdp
  /** waits for a page and returns a session on it, by default the Slack window */
  page(match?: (target: any) => boolean): Promise<Page>
  /** console output from every target, timestamped like the log */
  onConsole(listener: (line: LogLine) => void): () => void
  /** RSS and cumulative CPU for every process the instance owns */
  processes(): Promise<ProcessSample[]>
  /** runs a function in the main process over its inspector, an esm main has no `require` so electron comes from `process._linkedBinding('electron_browser_app' | 'electron_browser_window' | 'electron_browser_web_contents')` */
  main<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<T>
  stop(): Promise<number>
}

// repeated launches in one process share the compile
let built = false

export async function launchInstance(
  options: InstanceOptions = {}
): Promise<Instance> {
  const {
    url,
    onAttach,
    echo = true,
    background = false,
    systemInstall = false,
  } = options
  const root = options.root ?? instanceRoot(options.name ?? 'dev')
  const configDir = path.join(root, 'config')

  if (options.reset) await resetInstance(root)
  if (options.seed) await seedInstance(root)

  const cdpPort = options.cdpPort ?? (await freePort(9222))
  const inspectPort = options.inspectPort ?? (await freePort(cdpPort + 1))
  for (const [port, what] of [
    [cdpPort, 'devtools endpoint'],
    [inspectPort, 'main process inspector'],
  ] as const) {
    if (port && (await freePort(port)) !== port) {
      throw new Error(`port ${port} is taken, so the ${what} would not open`)
    }
  }

  await mkdir(path.join(root, 'logs'), { recursive: true })
  await mkdir(configDir, { recursive: true })
  // one link per cached slack under its <version>-<arch> name, so this copy's cache renames and prunes only ever touch links
  const slackCache = path.join(realConfigDir(), 'slack')
  const localSlack = path.join(configDir, 'slack')
  if ((await lstat(localSlack).catch(() => null))?.isSymbolicLink())
    await rm(localSlack)
  if (existsSync(slackCache)) {
    await mkdir(localSlack, { recursive: true })
    // matches slackArch in desktop/src/slackDownload.ts: slack ships no arm64 linux build, so arm64 linux caches the x64 deb
    const arch =
      process.platform !== 'linux' && process.arch === 'arm64' ? 'arm64' : 'x64'
    for (const entry of await readdir(slackCache)) {
      const match = /^\d+(?:\.\d+)*(-(?:x64|arm64))?$/.exec(entry)
      if (!match) continue
      const link = path.join(localSlack, match[1] ? entry : `${entry}-${arch}`)
      if (!(await lstat(link).catch(() => null)))
        await symlink(path.join(slackCache, entry), link, 'dir')
    }
  }
  const served = url && url in SERVED ? await serveBundle(url) : null
  if (url) await writeAppUrl(configDir, served?.url ?? URL_PRESETS[url] ?? url)

  if (!built) {
    await buildDesktopJs('standard')
    built = true
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = path.join(root, 'logs', `${stamp}.log`)
  const exe = path.join(
    ROOT,
    'node_modules/electron/dist',
    readFileSync(
      path.join(ROOT, 'node_modules/electron/path.txt'),
      'utf8'
    ).trim()
  )
  const argv = [
    DESKTOP,
    `--user-data-dir=${configDir}`,
    // a dev build never matches the "Taut Safe Storage" keychain ACL so macos asks for a password, the mock key leaves seeded cookies and secrets.dat unreadable but Slack's token is in localStorage
    '--use-mock-keychain',
    // chromium stops rendering an unfocused or transparent window it takes as occluded and throttles its timers, which zeroes out every measurement
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    `--remote-debugging-port=${cdpPort}`,
    ...(inspectPort ? [`--inspect=${inspectPort}`] : []),
  ]

  const log = createWriteStream(logPath, { flags: 'a' })
  log.write(`# ${exe} ${argv.join(' ')}\n# TAUT_CONFIG_DIR=${configDir}\n`)

  const startedAt = Date.now()
  const elapsed = () => Date.now() - startedAt
  const child = spawn(exe, argv, {
    env: {
      ...process.env,
      TAUT_CONFIG_DIR: configDir,
      ...(systemInstall ? {} : { TAUT_TEMPORARY: '1' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipeLines(
    child,
    () => elapsed(),
    (line) => {
      log.write(`${line}\n`)
      if (echo) console.log(line)
    }
  )

  let code: number | null = null
  const alive = () => code === null
  const exited = new Promise<number>((resolve) => {
    child.on('exit', (exitCode, signal) => {
      code = exitCode ?? (signal ? 128 : 0)
      resolve(code)
    })
  })
  // 'close' not 'exit' since stdio still delivers buffered lines after exit, and writing to an ended stream throws
  child.on('close', () => log.end(`# exited ${code}\n`))
  // a script that throws before stop() would otherwise leave the app running
  process.once('exit', () => child.kill('SIGKILL'))

  let inspector: Cdp | undefined
  const mainEval = async (fn: (...args: any[]) => any, ...args: unknown[]) => {
    if (!inspectPort) throw new Error('the main process inspector is closed')
    inspector ??= await poll(
      async () =>
        connect(
          (await cdpJson<any[]>(inspectPort, '/json/list'))[0]
            .webSocketDebuggerUrl
        ),
      alive
    )
    const expression = `(${fn})(${args.map((a) => JSON.stringify(a)).join(',')})`
    const { result, exceptionDetails } = await inspector.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }
    )
    if (exceptionDetails) {
      throw new Error(
        exceptionDetails.exception?.description ?? exceptionDetails.text
      )
    }
    return result.value
  }
  // before anything else waits, the window appears a few hundred ms in and focus is gone once it activates the app
  if (background) await keepInBackground(mainEval, alive)

  const endpoint = await poll(
    () => cdpJson<{ webSocketDebuggerUrl: string }>(cdpPort, '/json/version'),
    alive
  )
  const cdp = await connect(endpoint.webSocketDebuggerUrl)
  const consoleListeners = new Set<(line: LogLine) => void>()
  const sessions = new Map<string, Page>()

  cdp.on((event) => {
    if (event.method === 'Target.attachedToTarget') {
      const page = makePage(cdp, event.params.sessionId, () => elapsed(), alive)
      sessions.set(event.params.targetInfo.targetId, page)
      hold(page, event.params.targetInfo.type, onAttach)
      return
    }
    if (event.method !== 'Runtime.consoleAPICalled') return
    const text = (event.params.args ?? [])
      .map((arg: any) => arg.value ?? arg.description ?? '')
      .join(' ')
    const line = { ms: Math.round(event.params.timestamp - startedAt), text }
    for (const listener of consoleListeners) listener(line)
  })
  // pausing each target as it starts lets onAttach get in before the page's first script
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  })

  const instance: Instance = {
    root,
    configDir,
    cdpPort,
    inspectPort,
    logPath,
    pid: child.pid ?? -1,
    startedAt,
    elapsed,
    exited,
    alive,
    cdp,
    async page(match = (target) => /app\.slack\.com/.test(target.url)) {
      const target = await poll(
        async () =>
          (await cdpJson<any[]>(cdpPort, '/json/list')).find(
            (t) => t.type === 'page' && match(t)
          ),
        alive
      )
      const existing = sessions.get(target.id)
      if (existing) return existing
      const { sessionId } = await cdp.send('Target.attachToTarget', {
        targetId: target.id,
        flatten: true,
      })
      return makePage(cdp, sessionId, elapsed, alive)
    },
    onConsole(listener) {
      consoleListeners.add(listener)
      return () => consoleListeners.delete(listener)
    },
    processes: () => sampleProcesses(child.pid ?? -1),
    main: mainEval,
    async stop() {
      await served?.close()
      if (code !== null) return exited
      inspector?.close()
      cdp.close()
      child.kill('SIGTERM')
      const killer = setTimeout(() => child.kill('SIGKILL'), 5000)
      try {
        return await exited
      } finally {
        clearTimeout(killer)
      }
    },
  }

  return instance
}

// human note: this is ai jank, no idea how well it works

// macos: an "accessory" app never becomes active, and the window is transparent and click-through since chromium stops rendering one parked offscreen
async function keepInBackground(
  mainEval: (fn: (...args: any[]) => any, ...args: unknown[]) => Promise<any>,
  alive: () => boolean
) {
  await poll(
    () =>
      mainEval(() => {
        const binding = (process as any)._linkedBinding
        const { app } = binding('electron_browser_app')
        const { BrowserWindow } = binding('electron_browser_window')
        app.setActivationPolicy?.('accessory')
        try {
          app.dock?.hide?.()
        } catch {}
        app.focus = () => {}
        const hide = (win: any) => {
          try {
            win.setOpacity(0)
            win.setIgnoreMouseEvents(true)
            if (win.isFocused()) win.blur()
          } catch {}
        }
        if (!(app as any).__tautBackground) {
          ;(app as any).__tautBackground = true
          // electron reasserts a regular activation policy as it starts, so the app flashes to the front unless this keeps resetting it
          const keep = setInterval(() => {
            app.setActivationPolicy?.('accessory')
            for (const win of BrowserWindow.getAllWindows()) hide(win)
          }, 50)
          setTimeout(() => clearInterval(keep), 20_000)
          // setOpacity before a window is shown doesn't stick, so reapply on every event that can bring it forward
          app.on?.('browser-window-created', (_e: unknown, win: any) => {
            hide(win)
            for (const event of ['show', 'focus', 'restore', 'ready-to-show']) {
              win.on?.(event, () => hide(win))
            }
          })
        }
        for (const win of BrowserWindow.getAllWindows()) hide(win)
        return true
      }).catch(() => false),
    alive,
    { timeout: 20_000, interval: 20, what: 'the main process inspector' }
  )
}

async function hold(
  page: Page,
  type: string,
  onAttach: InstanceOptions['onAttach']
) {
  try {
    if (type === 'page') {
      await page.send('Runtime.enable')
      await page.send('Performance.enable')
      await onAttach?.(page)
    }
  } catch {}
  await page.send('Runtime.runIfWaitingForDebugger').catch(() => {})
}

/** stamps each line of both streams with ms since exec */
function pipeLines(
  child: ChildProcess,
  elapsed: () => number,
  emit: (line: string) => void
) {
  for (const stream of [child.stdout, child.stderr]) {
    let rest = ''
    stream?.on('data', (chunk: Buffer) => {
      const parts = (rest + chunk.toString()).split('\n')
      rest = parts.pop() ?? ''
      for (const line of parts) {
        emit(`${String(elapsed()).padStart(6)}ms ${line}`)
      }
    })
    stream?.on('end', () => {
      if (rest) emit(`${String(elapsed()).padStart(6)}ms ${rest}`)
    })
  }
}

export interface CpuProfile {
  /** wall time the profile covers */
  totalMs: number
  /** self time per script, biggest first */
  byScript: { url: string; ms: number }[]
  /** self time per function, biggest first */
  byFunction: { name: string; url: string; ms: number }[]
  /** the raw .cpuprofile, for devtools */
  raw: unknown
}

export interface Page {
  sessionId: string
  send<T = any>(method: string, params?: object): Promise<T>
  /** runs a function in the page, args are passed as JSON */
  eval<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<T>
  /** polls until the function is truthy, resolving with ms since exec */
  waitFor(
    fn: () => unknown,
    options?: { timeout?: number; interval?: number }
  ): Promise<number>
  /** Performance.getMetrics as a plain object */
  metrics(): Promise<Record<string, number>>
  /** v8 heap in bytes, after a forced collection */
  heapUsed(): Promise<number>
  /** starts sampling, the returned function stops and folds the profile */
  recordCpu(intervalUs?: number): Promise<() => Promise<CpuProfile>>
  /** writes a .heapsnapshot for devtools */
  heapSnapshot(file: string): Promise<string>
}

function makePage(
  cdp: Cdp,
  sessionId: string,
  elapsed: () => number,
  alive: () => boolean
): Page {
  const send = <T>(method: string, params: object = {}) =>
    cdp.send<T>(method, params, sessionId)

  const page: Page = {
    sessionId,
    send,
    async eval(fn, ...args) {
      const expression = `(${fn})(${args.map((a) => JSON.stringify(a)).join(',')})`
      const { result, exceptionDetails } = await send<any>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
      if (exceptionDetails) {
        throw new Error(
          exceptionDetails.exception?.description ?? exceptionDetails.text
        )
      }
      return result.value
    },
    waitFor: (fn, { timeout = 120_000, interval = 50 } = {}) =>
      poll<number>(
        async () => ((await page.eval(fn).catch(() => false)) ? elapsed() : 0),
        alive,
        { timeout, interval, what: String(fn) }
      ),
    async metrics() {
      const { metrics } = await send<any>('Performance.getMetrics')
      return Object.fromEntries(
        metrics.map((m: { name: string; value: number }) => [m.name, m.value])
      )
    },
    async heapUsed() {
      await send('HeapProfiler.collectGarbage').catch(() => {})
      return (await page.metrics()).JSHeapUsedSize
    },
    async recordCpu(intervalUs = 200) {
      await send('Profiler.enable')
      await send('Profiler.setSamplingInterval', { interval: intervalUs })
      await send('Profiler.start')
      return async () => {
        const { profile } = await send<any>('Profiler.stop')
        return foldCpuProfile(profile)
      }
    },
    async heapSnapshot(file) {
      const chunks: string[] = []
      const off = cdp.on((event) => {
        if (event.method === 'HeapProfiler.addHeapSnapshotChunk') {
          chunks.push(event.params.chunk)
        }
      })
      await send('HeapProfiler.takeHeapSnapshot')
      off()
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, chunks.join(''))
      return file
    },
  }
  return page
}

// each sample is charged the time delta before it, as devtools attributes them
export function foldCpuProfile(profile: any): CpuProfile {
  const self = new Map<number, number>()
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i]
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0))
  }

  const shorten = (url: string) =>
    url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '') || url
  const byFunction: CpuProfile['byFunction'] = []
  const byScript = new Map<string, number>()
  for (const node of profile.nodes) {
    const ms = (self.get(node.id) ?? 0) / 1000
    if (ms < 1) continue
    const { functionName, url, lineNumber } = node.callFrame
    const script = url ? shorten(url) : '(native)'
    byFunction.push({
      name: functionName || '(anonymous)',
      url: url ? `${script}:${lineNumber + 1}` : script,
      ms: Math.round(ms),
    })
    byScript.set(script, (byScript.get(script) ?? 0) + ms)
  }

  return {
    totalMs: Math.round((profile.endTime - profile.startTime) / 1000),
    byScript: [...byScript]
      .map(([url, ms]) => ({ url, ms: Math.round(ms) }))
      .sort((a, b) => b.ms - a.ms),
    byFunction: byFunction.sort((a, b) => b.ms - a.ms),
    raw: profile,
  }
}

// a CDP connection, attached targets multiplexed over it by sessionId

export interface Cdp {
  send<T = any>(method: string, params?: object, sessionId?: string): Promise<T>
  /** returns an unsubscribe function */
  on(listener: (event: { method: string; params: any }) => void): () => void
  close(): void
}

function connect(url: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pending = new Map<number, (result: any, error?: any) => void>()
    const listeners = new Set<(event: any) => void>()
    let nextId = 1

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (typeof message.id !== 'number') {
        for (const listener of listeners) listener(message)
        return
      }
      pending.get(message.id)?.(message.result, message.error)
      pending.delete(message.id)
    })
    ws.addEventListener('error', () => reject(new Error(`cannot open ${url}`)))
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}, sessionId) {
          const id = nextId++
          ws.send(JSON.stringify({ id, method, params, sessionId }))
          return new Promise((ok, fail) => {
            pending.set(id, (result, error) =>
              error
                ? fail(new Error(`${method}: ${error.message}`))
                : ok(result)
            )
          })
        },
        on(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        close: () => ws.close(),
      })
    )
  })
}

const cdpJson = async <T>(port: number, route: string): Promise<T> => {
  const res = await fetch(`http://127.0.0.1:${port}${route}`)
  if (!res.ok) throw new Error(`${route} responded ${res.status}`)
  return res.json() as Promise<T>
}

/** retries until the value is truthy, giving up if the app dies */
async function poll<T>(
  get: () => T | Promise<T>,
  alive: () => boolean,
  { timeout = 120_000, interval = 50, what = 'the app' } = {}
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await Promise.resolve(get()).catch(() => null)
    if (value) return value as NonNullable<T>
    if (!alive()) throw new Error(`${what} exited early`)
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(interval)
  }
}

async function sampleProcesses(root: number): Promise<ProcessSample[]> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { stdout } = await promisify(execFile)('ps', [
    '-axo',
    'pid=,ppid=,rss=,time=,args=',
  ])
  const rows = stdout
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => !!match)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      // ps prints [[hh:]mm:]ss.ff
      cpuSeconds: match[4].split(':').reduce((t, part) => t * 60 + +part, 0),
      type: match[5].match(/--type=(\S+)/)?.[1] ?? 'browser',
    }))

  const tree: ProcessSample[] = []
  const walk = (pid: number) => {
    const row = rows.find((r) => r.pid === pid)
    if (row) tree.push({ ...row })
    for (const child of rows.filter((r) => r.ppid === pid)) walk(child.pid)
  }
  walk(root)
  return tree
}
