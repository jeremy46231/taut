// Taut Desktop Bridge: IPC handlers for config, storage, cookies and fetch

import { type FSWatcher, promises as fs, watch } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dialog, ipcMain, net, safeStorage, session } from 'electron'
import { writeFileAtomic } from './atomicWrite.js'
import { readyUpdate, restartToUpdate } from './autoUpdate.js'
import { getInstall } from './installType.js'
import type { DesktopRpc } from './rpc'
import { checkForUpdates } from './updates.js'

export interface BridgeConfig {
  configDir: string
}

async function fileExists(p: string) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// an editor that truncates then writes fires twice, and forwarding the empty read in between resets every plugin
function settledReader(read: () => Promise<void>) {
  let timer: NodeJS.Timeout | undefined
  let running = Promise.resolve()
  return () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      running = running.then(() => read().catch(() => {}))
    }, 50)
  }
}

export function setupBridge(
  config: BridgeConfig,
  opts: {
    getAppUrl: () => string
    setAppUrl: (url: string) => Promise<void>
  }
) {
  ipcMain.handle('taut:get-paths', () => {
    const home = os.homedir()
    const dp = (p: string) =>
      p.startsWith(home) ? `~${p.slice(home.length)}` : p
    const tautDir = config.configDir
    const configFile = path.join(tautDir, 'config.json')
    const userCssFile = path.join(tautDir, 'user.css')
    return {
      tautDir,
      plugins: path.join(tautDir, 'plugins'),
      userPlugins: path.join(tautDir, 'user-plugins'),
      config: configFile,
      userCss: userCssFile,
      display: {
        tautDir: dp(tautDir),
        plugins: dp(path.join(tautDir, 'plugins')),
        userPlugins: dp(path.join(tautDir, 'user-plugins')),
        config: dp(configFile),
        userCss: dp(userCssFile),
      },
    }
  })

  ipcMain.handle('taut:get-install', () => getInstall())
  ipcMain.handle('taut:get-update-ready', () => readyUpdate())
  ipcMain.handle('taut:restart-to-update', () => restartToUpdate())
  ipcMain.handle('taut:get-app-url', () => opts.getAppUrl())
  ipcMain.handle('taut:set-app-url', async (_, url: string) => {
    await opts.setAppUrl(url)
  })
  // the app is newer than this loader supports, see MIN_BRIDGE_VERSION
  ipcMain.handle('taut:warn-outdated', async () => {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      message: 'This Taut desktop app is too old',
      detail: 'Slack will load without Taut until you update it.',
      buttons: ['Check for Updates', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) await checkForUpdates()
  })

  const configFile = path.join(config.configDir, 'config.json')
  // Taut before 3.0 used config.jsonc, the app rewrites its contents
  const configRenamed = (async () => {
    const old = path.join(config.configDir, 'config.jsonc')
    if ((await fileExists(configFile)) || !(await fileExists(old))) return
    await fs
      .rename(old, configFile)
      .catch((err) => console.error('[Taut] Failed to rename config:', err))
  })()
  const userCssFile = path.join(config.configDir, 'user.css')
  const userPluginsDir = path.join(config.configDir, 'user-plugins')

  // must be safe as a filename too
  const isSafePluginId = (id: string) =>
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 100 &&
    !id.includes('/') &&
    !id.includes('\\') &&
    id !== '.' &&
    id !== '..'
  const userPluginFile = (id: string) => path.join(userPluginsDir, `${id}.js`)

  const blobRoot = path.join(config.configDir, 'store')
  const encodeSegment = (s: string) =>
    Buffer.from(s, 'utf8').toString('base64url')
  const decodeSegment = (s: string) =>
    Buffer.from(s, 'base64url').toString('utf8')
  const blobNamespaceDir = (namespace: string) =>
    path.join(blobRoot, encodeSegment(namespace))
  const blobKeyFile = (namespace: string, key: string) =>
    path.join(blobNamespaceDir(namespace), `${encodeSegment(key)}.txt`)

  // by webContents id, since every reload calls start() again
  const senderWatchers = new Map<number, FSWatcher[]>()
  ipcMain.handle('taut:setup-watchers', async (event) => {
    const sender = event.sender
    const senderId = sender.id
    const previous = senderWatchers.get(senderId)
    if (previous) for (const watcher of previous) watcher.close()
    else
      sender.once('destroyed', () => {
        for (const watcher of senderWatchers.get(senderId) ?? [])
          watcher.close()
        senderWatchers.delete(senderId)
      })
    const watchers: FSWatcher[] = []
    senderWatchers.set(senderId, watchers)
    try {
      await fs.mkdir(config.configDir, { recursive: true })
      await fs.mkdir(userPluginsDir, { recursive: true })

      // watch the dir since a file watch follows the inode and misses editors that replace the file
      await configRenamed
      if (senderWatchers.get(senderId) !== watchers) return
      const readConfig = settledReader(async () => {
        const text = await fs.readFile(configFile, 'utf8')
        sender.send('taut:config-text-changed', text)
      })
      const readUserCss = settledReader(async () => {
        const css = await fs.readFile(userCssFile, 'utf8')
        sender.send('taut:user-css-changed', css)
      })
      const configWatcher = watch(config.configDir, (_, filename) => {
        if (filename === 'config.json') readConfig()
        else if (filename === 'user.css') readUserCss()
      })

      const userPluginReaders = new Map<string, () => void>()
      const userPluginWatcher = watch(userPluginsDir, (_, filename) => {
        if (!filename?.endsWith('.js')) return
        const id = filename.slice(0, -'.js'.length)
        if (!isSafePluginId(id)) return
        let read = userPluginReaders.get(id)
        if (!read) {
          read = settledReader(async () => {
            const code = await fs
              .readFile(userPluginFile(id), 'utf8')
              .catch(() => null)
            sender.send('taut:user-plugin-changed', id, code)
          })
          userPluginReaders.set(id, read)
        }
        read()
      })
      watchers.push(configWatcher, userPluginWatcher)

      if (await fileExists(userCssFile)) {
        const css = await fs.readFile(userCssFile, 'utf8')
        sender.send('taut:user-css-changed', css)
      }
    } catch (err) {
      console.error('[Taut] Failed to set up watchers:', err)
    }
  })

  const cookies = () => session.defaultSession.cookies

  const secretsFile = path.join(config.configDir, 'secrets.dat')

  async function readSecrets(): Promise<Record<string, string>> {
    try {
      if (!(await fileExists(secretsFile))) return {}
      const raw = await fs.readFile(secretsFile)
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString('utf8')
      return JSON.parse(json)
    } catch {
      return {}
    }
  }

  async function writeSecrets(
    secrets: Record<string, string>
  ): Promise<boolean> {
    try {
      const json = JSON.stringify(secrets)
      const data = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(json)
        : Buffer.from(json, 'utf8')
      await writeFileAtomic(secretsFile, data)
      return true
    } catch (e) {
      console.error('[Taut] write-secret failed:', e)
      return false
    }
  }

  async function readTextFile(file: string, fallback: string): Promise<string> {
    try {
      if (await fileExists(file)) return await fs.readFile(file, 'utf8')
    } catch {}
    return fallback
  }

  async function writeTextFile(file: string, text: string): Promise<boolean> {
    try {
      await writeFileAtomic(file, text)
      return true
    } catch {
      return false
    }
  }

  const rpcMethods: DesktopRpc = {
    fetch: (url, init) =>
      new Promise((resolve, reject) => {
        const headers = { ...(init.headers ?? {}) }
        const hasCookie = Object.keys(headers)
          .map((h) => h.toLowerCase())
          .includes('cookie')
        const req = net.request({
          method: init.method ?? 'GET',
          url,
          useSessionCookies: !hasCookie,
        })
        for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)
        req.on('response', (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c as Buffer))
          res.on('end', () => {
            const respHeaders: Record<string, string> = {}
            for (const [k, v] of Object.entries(res.headers))
              respHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v)
            resolve({
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: respHeaders,
              // raw bytes, a UTF-8 string would mangle binary bodies
              body: Buffer.concat(chunks),
            })
          })
        })
        req.on('error', reject)
        if (init.body) req.write(init.body)
        req.end()
      }),
    readConfigText: async () => {
      await configRenamed
      return readTextFile(configFile, '')
    },
    writeConfigText: async (text) => {
      await configRenamed
      return writeTextFile(configFile, text)
    },
    readUserCss: () => readTextFile(userCssFile, ''),
    writeUserCss: (text) => writeTextFile(userCssFile, text),
    readSecret: async (key) => (await readSecrets())[key] ?? null,
    writeSecret: async (key, value) => {
      const secrets = await readSecrets()
      secrets[key] = value
      return writeSecrets(secrets)
    },
    deleteSecret: async (key) => {
      const secrets = await readSecrets()
      if (!(key in secrets)) return true
      delete secrets[key]
      return writeSecrets(secrets)
    },
    listUserPlugins: async () => {
      try {
        const entries = await fs.readdir(userPluginsDir)
        return entries
          .filter((f) => f.endsWith('.js'))
          .map((f) => f.slice(0, -'.js'.length))
          .filter(isSafePluginId)
      } catch {
        return []
      }
    },
    readUserPlugin: async (id) => {
      if (!isSafePluginId(id)) return null
      try {
        return await fs.readFile(userPluginFile(id), 'utf8')
      } catch {
        return null
      }
    },
    writeUserPlugin: async (id, code) => {
      if (!isSafePluginId(id)) return false
      try {
        await writeFileAtomic(userPluginFile(id), code)
        return true
      } catch {
        return false
      }
    },
    deleteUserPlugin: async (id) => {
      if (!isSafePluginId(id)) return false
      try {
        await fs.rm(userPluginFile(id), { force: true })
        return true
      } catch {
        return false
      }
    },
    blobList: async (namespace) => {
      try {
        const entries = await fs.readdir(blobNamespaceDir(namespace))
        return entries
          .filter((f) => f.endsWith('.txt'))
          .map((f) => decodeSegment(f.slice(0, -'.txt'.length)))
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
        throw err
      }
    },
    blobRead: async (namespace, key) => {
      try {
        return await fs.readFile(blobKeyFile(namespace, key), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw err
      }
    },
    blobWrite: async (namespace, key, value) => {
      try {
        await writeFileAtomic(blobKeyFile(namespace, key), value)
        return true
      } catch {
        return false
      }
    },
    blobDelete: async (namespace, key) => {
      try {
        await fs.rm(blobKeyFile(namespace, key), { force: true })
        return true
      } catch {
        return false
      }
    },
    blobClear: async (namespace) => {
      try {
        await fs.rm(blobNamespaceDir(namespace), {
          recursive: true,
          force: true,
        })
        return true
      } catch {
        return false
      }
    },
    cookieGet: async (details) =>
      (await cookies().get({ url: details.url, name: details.name }))[0] ??
      null,
    cookieGetAll: (details) => cookies().get(details),
    cookieSet: async (cookie) => {
      try {
        await cookies().set(cookie)
        return true
      } catch (e) {
        console.error('[Taut] cookieSet failed:', e)
        return false
      }
    },
    cookieRemove: async (details) => {
      try {
        await cookies().remove(details.url, details.name)
        return true
      } catch (e) {
        console.error('[Taut] cookieRemove failed:', e)
        return false
      }
    },
  }

  ipcMain.handle('taut:rpc', (_event, method: string, args: unknown[]) => {
    const fn = (rpcMethods as Record<string, (...a: unknown[]) => unknown>)[
      method
    ]
    if (!fn) throw new Error(`[Taut] Unknown RPC method: ${method}`)
    return fn(...args)
  })
}
