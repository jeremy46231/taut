// Taut Desktop Preload

import type { TautBridge, TautInstall } from '../../shared/TautBridge'
import type { RpcArgs, RpcMethod, RpcResult, SerialFetchInit } from './rpc'

declare const __TAUT_LOADER_VERSION__: string
declare const __TAUT_EMBEDDED__: boolean

const { contextBridge, ipcRenderer } = require('electron')

const origPreloadPromise = ipcRenderer.invoke(
  'taut:get-original-preload'
) as Promise<string | null>
const origHtmlPromise = fetch(location.href).then((r) => r.text())
const tautUrlPromise = ipcRenderer.invoke('taut:get-app-url') as Promise<string>
const pathsPromise = ipcRenderer.invoke('taut:get-paths')
const installPromise = (
  ipcRenderer.invoke('taut:get-install') as Promise<TautInstall>
).catch(() => undefined)

const isClientPage = /\/client(\/|$)/.test(location.pathname)

if (isClientPage) {
  document.open()
  document.write('<!DOCTYPE html>')
  document.close()
}

;(async () => {
  try {
    // Slack's preload runs first so its exposeInMainWorld calls land before Slack's scripts
    const origPreload = await origPreloadPromise
    if (origPreload) {
      console.log('[Taut] Evaluating Slack original preload')
      // biome-ignore lint/security/noGlobalEval: we have to eval the original preload that we replaced
      eval(origPreload)
    }
  } catch (e) {
    console.error('[Taut] Failed to eval Slack preload:', e)
  }

  if (!isClientPage) {
    console.log('[Taut] Skipping patch for non-client page:', location.pathname)
    return
  }

  let html: string
  try {
    html = await origHtmlPromise
  } catch (e) {
    console.error('[Taut] Failed to fetch page HTML:', e)
    return
  }

  let tautUrl: string
  try {
    tautUrl = await tautUrlPromise
  } catch {
    tautUrl = 'https://taut.jer.app/taut.js'
  }

  const paths = await pathsPromise
  const install = await installPromise

  const call = <M extends RpcMethod>(
    method: M,
    args: RpcArgs<M>
  ): Promise<RpcResult<M>> => ipcRenderer.invoke('taut:rpc', method, args)

  contextBridge.exposeInMainWorld('TautBridge', {
    loader: 'electron' as const,
    loaderVersion: __TAUT_LOADER_VERSION__,
    bridgeVersion: 3,
    embedded: __TAUT_EMBEDDED__,
    install,
    PATHS: paths,

    // see autoUpdate.ts
    ...(install?.canSelfUpdate
      ? {
          restartToUpdate: () => ipcRenderer.invoke('taut:restart-to-update'),
          onUpdateReady(cb: (version: string) => void) {
            const handler = (_: unknown, version: string) => cb(version)
            ipcRenderer.on('taut:update-ready', handler)
            ;(
              ipcRenderer.invoke('taut:get-update-ready') as Promise<
                string | null
              >
            ).then((version) => version && cb(version))
            return () =>
              ipcRenderer.removeListener('taut:update-ready', handler)
          },
        }
      : {}),

    cookies: {
      get: (details) => call('cookieGet', [details]).catch(() => null),
      getAll: (details) => call('cookieGetAll', [details]).catch(() => []),
      set: (cookie) => call('cookieSet', [cookie]).catch(() => false),
      remove: (details) => call('cookieRemove', [details]).catch(() => false),
    },

    readSecret: (key) => call('readSecret', [key]).catch(() => null),
    writeSecret: (key, value) =>
      call('writeSecret', [key, value]).catch(() => false),
    deleteSecret: (key) => call('deleteSecret', [key]).catch(() => false),

    userPlugins: {
      list: () => call('listUserPlugins', []).catch(() => []),
      read: (id) => call('readUserPlugin', [id]).catch(() => null),
      write: (id, code) =>
        call('writeUserPlugin', [id, code]).catch(() => false),
      delete: (id) => call('deleteUserPlugin', [id]).catch(() => false),
      onChange(cb: (id: string, code: string | null) => void) {
        const handler = (_: unknown, id: string, code: string | null) =>
          cb(id, code)
        ipcRenderer.on('taut:user-plugin-changed', handler)
        return () =>
          ipcRenderer.removeListener('taut:user-plugin-changed', handler)
      },
    },

    blobStore: (namespace: string) => ({
      list: () => call('blobList', [namespace]),
      read: (key) => call('blobRead', [namespace, key]),
      write: (key, value) =>
        call('blobWrite', [namespace, key, value]).catch(() => false),
      delete: (key) => call('blobDelete', [namespace, key]).catch(() => false),
      clear: () => call('blobClear', [namespace]).catch(() => false),
    }),

    start: () => ipcRenderer.invoke('taut:setup-watchers'),

    readConfigText: () => call('readConfigText', []),
    writeConfigText: (text) => call('writeConfigText', [text]),

    onConfigTextChange(cb: (text: string) => void) {
      const handler = (_: unknown, text: string) => cb(text)
      ipcRenderer.on('taut:config-text-changed', handler)
      return () =>
        ipcRenderer.removeListener('taut:config-text-changed', handler)
    },

    readUserCss: () => call('readUserCss', []),
    writeUserCss: (css) => call('writeUserCss', [css]),

    onUserCssChange(cb: (css: string) => void) {
      const handler = (_: unknown, css: string) => cb(css)
      ipcRenderer.on('taut:user-css-changed', handler)
      return () => ipcRenderer.removeListener('taut:user-css-changed', handler)
    },

    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const serialInit: SerialFetchInit = {}
      if (init?.method) serialInit.method = init.method
      if (init?.body && typeof init.body === 'string')
        serialInit.body = init.body
      if (init?.headers) {
        const headers: Record<string, string> = {}
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => {
            headers[k] = v
          })
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) headers[k] = v
        } else {
          Object.assign(headers, init.headers)
        }
        serialInit.headers = headers
      }
      // contextBridge structure-clones this
      return call('fetch', [url, serialInit])
    },

    warnOutdated: () => ipcRenderer.invoke('taut:warn-outdated'),
  } satisfies TautBridge)

  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.remove()

  const scripts = Array.from(doc.querySelectorAll('script')).map((s) => ({
    src: (s as HTMLScriptElement).src,
    textContent: s.textContent,
    type: s.getAttribute('type'),
  }))
  doc.querySelectorAll('script').forEach((s) => {
    s.remove()
  })

  const scriptError = (url: string) =>
    `alert('[Taut] Failed to load a script.\\n\\nURL: ' + ${JSON.stringify(url)} + '\\n\\n${url.includes('://localhost') ? 'Make sure your server is running.' : 'Ask in #taut for help.'}')`

  const tautScript = doc.createElement('script')
  tautScript.id = 'taut-app'
  tautScript.src = tautUrl
  tautScript.setAttribute('onerror', scriptError(tautScript.src))
  doc.head.appendChild(tautScript)

  for (const { src, textContent, type } of scripts) {
    const s = doc.createElement('script')
    if (type) s.type = type
    if (src) s.src = src
    else if (textContent) s.textContent = textContent
    doc.head.appendChild(s)
  }

  document.open()
  document.write(`<!DOCTYPE html>${doc.documentElement.outerHTML}`)
  document.close()

  console.log(
    '[Taut] Document reconstructed with CSP removed and taut.js injected'
  )
})()
