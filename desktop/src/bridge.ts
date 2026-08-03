// Taut Desktop Bridge
// IPC handlers for config/CSS management and fetch relay

import { promises as fs, watch } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain, net, safeStorage, session } from 'electron'
import type { DesktopRpc } from './rpc'

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

export function setupBridge(
  config: BridgeConfig,
  opts: {
    getAppUrl: () => string
    setAppUrl: (url: string) => Promise<void>
    openOptionsWindow: () => void
  }
) {
  ipcMain.handle('taut:get-paths', () => {
    const home = os.homedir()
    const dp = (p: string) =>
      p.startsWith(home) ? `~${p.slice(home.length)}` : p
    const tautDir = config.configDir
    const configFile = path.join(tautDir, 'config.jsonc')
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

  ipcMain.handle('taut:get-app-url', () => opts.getAppUrl())
  ipcMain.handle('taut:set-app-url', async (_, url: string) => {
    await opts.setAppUrl(url)
  })
  ipcMain.handle('taut:warn-outdated', () => opts.openOptionsWindow())

  const configFile = path.join(config.configDir, 'config.jsonc')
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

  // Generic blob storage, namespaces/keys are base64url-encoded into the path
  const blobRoot = path.join(config.configDir, 'store')
  const encodeSegment = (s: string) =>
    Buffer.from(s, 'utf8').toString('base64url')
  const decodeSegment = (s: string) =>
    Buffer.from(s, 'base64url').toString('utf8')
  const blobNamespaceDir = (namespace: string) =>
    path.join(blobRoot, encodeSegment(namespace))
  const blobKeyFile = (namespace: string, key: string) =>
    path.join(blobNamespaceDir(namespace), `${encodeSegment(key)}.txt`)

  // Config/CSS watchers (set up once at startup)
  ipcMain.handle('taut:setup-watchers', async (event) => {
    const sender = event.sender
    try {
      await fs.mkdir(config.configDir, { recursive: true })
      await fs.mkdir(userPluginsDir, { recursive: true })

      // Watch configDir for config.jsonc and user.css changes (inode-based)
      watch(config.configDir, async (_, filename) => {
        if (!filename) return
        if (filename === 'config.jsonc') {
          try {
            const text = await fs.readFile(configFile, 'utf8')
            sender.send('taut:config-text-changed', text)
          } catch {}
        } else if (filename === 'user.css') {
          try {
            const css = await fs.readFile(userCssFile, 'utf8')
            sender.send('taut:user-css-changed', css)
          } catch {}
        }
      })

      // Watch user-plugins for added/edited/deleted plugin files
      const userPluginWatchQueues = new Map<string, Promise<void>>()
      watch(userPluginsDir, (_, filename) => {
        if (!filename?.endsWith('.js')) return
        const id = filename.slice(0, -'.js'.length)
        if (!isSafePluginId(id)) return
        const previous = userPluginWatchQueues.get(id) ?? Promise.resolve()
        const queued = previous.then(async () => {
          try {
            const code = await fs.readFile(userPluginFile(id), 'utf8')
            sender.send('taut:user-plugin-changed', id, code)
          } catch {
            // File removed
            sender.send('taut:user-plugin-changed', id, null)
          }
        })
        userPluginWatchQueues.set(id, queued)
        queued.finally(() => {
          if (userPluginWatchQueues.get(id) === queued)
            userPluginWatchQueues.delete(id)
        })
      })

      // Send initial user.css if the file already exists
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
      await fs.mkdir(config.configDir, { recursive: true })
      const json = JSON.stringify(secrets)
      const data = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(json)
        : Buffer.from(json, 'utf8')
      await fs.writeFile(secretsFile, data)
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
      await fs.mkdir(config.configDir, { recursive: true })
      await fs.writeFile(file, text, 'utf8')
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
          /** @type {Buffer[]} */
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
              body: Buffer.concat(chunks).toString('utf8'),
            })
          })
        })
        req.on('error', reject)
        if (init.body) req.write(init.body)
        req.end()
      }),
    readConfigText: () => readTextFile(configFile, ''),
    writeConfigText: (text) => writeTextFile(configFile, text),
    readUserCss: () => readTextFile(userCssFile, ''),
    writeUserCss: (text) => writeTextFile(userCssFile, text),
    readSecret: async (key) => (await readSecrets())[key] ?? null,
    writeSecret: async (key, value) => {
      const secrets = await readSecrets()
      secrets[key] = value
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
        await fs.mkdir(userPluginsDir, { recursive: true })
        await fs.writeFile(userPluginFile(id), code, 'utf8')
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
        await fs.mkdir(blobNamespaceDir(namespace), { recursive: true })
        await fs.writeFile(blobKeyFile(namespace, key), value, 'utf8')
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
