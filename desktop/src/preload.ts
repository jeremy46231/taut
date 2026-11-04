// Taut Desktop Preload

import type {
  TautBridge,
  TautInstall,
  TautTrayEvent,
} from '../../shared/TautBridge'
import type { RpcArgs, RpcMethod, RpcResult, SerialFetchInit } from './rpc'

declare const __TAUT_LOADER_VERSION__: string
declare const __TAUT_EMBEDDED__: boolean

const { contextBridge, ipcRenderer, webFrame } = require('electron')

// patch.ts made this window frameless, so turn on slack's windows title bar, a debug feature on linux
const frameless = process.argv.includes('--taut-frameless')

if (frameless) {
  const sendSync = ipcRenderer.sendSync.bind(ipcRenderer)
  ipcRenderer.sendSync = (channel: string, ...args: unknown[]) => {
    const result = sendSync(channel, ...args)
    if (channel !== 'SLACK_GET_REDUX_STATE' || !result?.settings) return result
    const withFlag = (layer: { debugFeatures?: string[] } = {}) => ({
      ...layer,
      debugFeatures: [...(layer.debugFeatures ?? []), 'window-chrome'],
    })
    // slack's preload rebuilds settings from its layers on every update, so slackDefaults needs the flag too
    return {
      ...result,
      settings: {
        ...withFlag(result.settings),
        slackDefaults: withFlag(result.settings.slackDefaults),
      },
    }
  }
  // keep slack's top nav clear of the window controls, which gtk can put on either side
  // the menu button's slot already pads it, so it overlaps left controls by 18px to keep the spacing correct
  webFrame.insertCSS(`
    .p-ia4_top_nav__native_ui_spacer { margin-left: max(0px, env(titlebar-area-x, 0px) - 18px) !important; }
    .p-ia4_top_nav__right_container { margin-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)) !important; }
  `)
}

try {
  const origPreload: string | null = ipcRenderer.sendSync(
    'taut:get-original-preload'
  )
  if (origPreload) {
    console.log('[Taut] Evaluating Slack original preload')
    // biome-ignore lint/security/noGlobalEval: we have to eval the original preload that we replaced
    eval(origPreload)
  }
} catch (e) {
  console.error('[Taut] Failed to eval Slack preload:', e)
}

// what slack's useWindowThemedTitlebar does on windows: color the window controls and match the top nav's height
const desktop = frameless ? (window as any).desktop : undefined
const store = desktop?.windowChrome?.getStore()
const windowId: Promise<number> | undefined = desktop?.window?.getWindowId()
if (store && windowId) {
  let applied = ''
  const syncWindowControls = async () => {
    const id = await windowId
    const symbolColor: string | undefined = store.getState().titleBar?.textColor
    const nav = document.querySelector('.p-ia4_top_nav')
    // slack's formula, the top nav's height in window pixels minus 1
    const height =
      nav &&
      Math.round(
        nav.getBoundingClientRect().height * webFrame.getZoomFactor()
      ) - 1
    const options = {
      ...(symbolColor && { symbolColor }),
      ...(height && height > 0 && { height }),
    }
    const key = JSON.stringify(options)
    if (key === '{}' || key === applied) return
    applied = key
    desktop.window.setTitleBarOverlay(id, options)
  }
  store.subscribe(syncWindowControls)
  // zooming resizes the viewport, and unlike the window's, its listeners survive document.open()
  visualViewport?.addEventListener('resize', syncWindowControls)
  syncWindowControls()
}

// parallel to extension/chrome/content.js, extension/firefox/background.js, extension/shared/bridge-setup.template.js, userscript/main.ts, and userscript/bridge.ts

async function readPage(response: Response) {
  const type = response.headers.get('content-type') ?? ''
  const sameOrigin = new URL(response.url).origin === location.origin
  if (!response.ok || !sameOrigin || !type.startsWith('text/html'))
    throw new Error(
      `Unexpected response: ${response.status} ${response.url} ${type}`
    )
  return response.text()
}

function reloadWithoutTaut(error: unknown) {
  console.error('[Taut] Failed to rewrite the page:', error)
  try {
    sessionStorage.setItem('taut_rewrite_failed', '1')
  } catch {
    return
  }
  location.reload()
}

;(async () => {
  // the preload runs on every page, the other loaders only match the client
  if (!/\/client(\/|$)/.test(location.pathname)) {
    console.log('[Taut] Skipping patch for non-client page:', location.pathname)
    return
  }

  let rewriteFailed = false
  try {
    rewriteFailed = sessionStorage.getItem('taut_rewrite_failed') !== null
    sessionStorage.removeItem('taut_rewrite_failed')
  } catch {}
  if (rewriteFailed) {
    console.warn('[Taut] Loading Slack without Taut after a failed rewrite')
    return
  }

  const DEFAULT_URL = 'https://taut.jer.app/taut.js'

  // left open, so DOMContentLoaded only fires on the rewritten page, where slack's preload sets up the menu button
  document.open()
  document.write('<!DOCTYPE html>')

  const [tautUrl, html, paths, install] = await Promise.all([
    (ipcRenderer.invoke('taut:get-app-url') as Promise<string>).catch(
      () => DEFAULT_URL
    ),
    fetch(location.href).then(readPage),
    ipcRenderer.invoke('taut:get-paths'),
    (ipcRenderer.invoke('taut:get-install') as Promise<TautInstall>).catch(
      () => undefined
    ),
  ])

  const call = <M extends RpcMethod>(
    method: M,
    args: RpcArgs<M>
  ): Promise<RpcResult<M>> => ipcRenderer.invoke('taut:rpc', method, args)

  contextBridge.exposeInMainWorld('TautBridge', {
    loader: 'electron' as const,
    loaderVersion: __TAUT_LOADER_VERSION__,
    bridgeVersion: 3,
    embedded: __TAUT_EMBEDDED__,
    PATHS: paths,
    install,

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

    relaunch: () => ipcRenderer.invoke('taut:relaunch'),
    loaderSettings: {
      list: () => call('listLoaderSettings', []).catch(() => []),
      set: (id, value) =>
        call('setLoaderSetting', [id, value]).catch(() => false),
    },

    cookies: {
      get: (details) => call('cookieGet', [details]).catch(() => null),
      getAll: (details) => call('cookieGetAll', [details]).catch(() => []),
      set: (cookie) => call('cookieSet', [cookie]).catch(() => false),
      remove: (details) => call('cookieRemove', [details]).catch(() => false),
    },

    readSecret: (key) => call('readSecret', [key]),
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

    tray: {
      state: () => ipcRenderer.invoke('taut:tray-state'),
      setHidden: (hidden: boolean) =>
        ipcRenderer.send('taut:tray-hidden', hidden),
      intercept: (events: TautTrayEvent[]) =>
        ipcRenderer.send('taut:tray-intercept', events),
      onEvent(cb: (event: TautTrayEvent) => void) {
        const handler = (_: unknown, event: TautTrayEvent) => cb(event)
        ipcRenderer.on('taut:tray-event', handler)
        return () => ipcRenderer.removeListener('taut:tray-event', handler)
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
    writeConfigText: (text) =>
      call('writeConfigText', [text]).catch(() => false),

    onConfigTextChange(cb: (text: string) => void) {
      const handler = (_: unknown, text: string) => cb(text)
      ipcRenderer.on('taut:config-text-changed', handler)
      return () =>
        ipcRenderer.removeListener('taut:config-text-changed', handler)
    },

    readUserCss: () => call('readUserCss', []),
    writeUserCss: (text) => call('writeUserCss', [text]).catch(() => false),

    onUserCssChange(cb: (css: string) => void) {
      const handler = (_: unknown, css: string) => cb(css)
      ipcRenderer.on('taut:user-css-changed', handler)
      return () => ipcRenderer.removeListener('taut:user-css-changed', handler)
    },

    fetch(input: RequestInfo | URL, init?: RequestInit) {
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
      // contextBridge structure-clones this, so the app rebuilds the Response
      return call('fetch', [url, serialInit])
    },

    warnOutdated: () => ipcRenderer.invoke('taut:warn-outdated'),
  } satisfies TautBridge)

  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.remove()

  const scripts = Array.from(doc.querySelectorAll('script')).map((s) => ({
    src: s.src,
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
})().catch(reloadWithoutTaut)
