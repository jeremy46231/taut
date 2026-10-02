// Taut Bridge Setup Template
// Sets up window.TautBridge in main world using postMessage relay to content script

;(() => {
  let msgId = 0

  /**
   * @template {import('./rpc').RpcMethod} M
   * @param {M} method
   * @param {import('./rpc').RpcArgs<M>} args
   * @returns {Promise<import('./rpc').RpcResult<M>>}
   */
  function call(method, args) {
    return new Promise((resolve, reject) => {
      const id = ++msgId
      const handler = /** @type {(e: MessageEvent) => void} */ (
        (e) => {
          const msg = e.data
          if (!msg?.__taut || msg.kind !== 'rpc:result' || msg.id !== id) return
          window.removeEventListener('message', handler)
          if (msg.ok) resolve(msg.value)
          else reject(new Error(msg.error))
        }
      )
      window.addEventListener('message', handler)
      window.postMessage(
        /** @type {import('./rpc').RpcRequest} */ ({
          __taut: true,
          kind: 'rpc',
          id,
          method,
          args,
        })
      )
    })
  }

  const configTextCallbacks = new Set()
  const userCssCallbacks = new Set()
  const userPluginCallbacks = new Set()

  window.addEventListener('message', (e) => {
    const msg = e.data
    if (!msg?.__taut || msg.kind !== 'event') return
    if (msg.name === 'userPlugin.changed') {
      const { id, code } = msg.payload
      for (const cb of userPluginCallbacks) cb(id, code)
      return
    }
    if (msg.name !== 'storage.changed') return
    const { key, newValue } = msg.payload
    if (key === 'taut-config')
      for (const cb of configTextCallbacks) cb(newValue)
    if (key === 'taut-user-css') for (const cb of userCssCallbacks) cb(newValue)
  })

  /** @satisfies {import('../../shared/TautBridge').TautBridge} */
  window.TautBridge = {
    loader:
      /** @type {import('../../shared/TautBridge').TautBridge['loader']} */ (
        '__TAUT_LOADER__'
      ),
    loaderVersion: '__TAUT_LOADER_VERSION__',
    bridgeVersion: 3,
    embedded: __TAUT_EMBEDDED__,
    PATHS: null,

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
      onChange(cb) {
        userPluginCallbacks.add(cb)
        return () => userPluginCallbacks.delete(cb)
      },
    },

    blobStore(namespace) {
      return {
        list: () => call('blobList', [namespace]),
        read: (key) => call('blobRead', [namespace, key]),
        write: (key, value) =>
          call('blobWrite', [namespace, key, value]).catch(() => false),
        delete: (key) =>
          call('blobDelete', [namespace, key]).catch(() => false),
        clear: () => call('blobClear', [namespace]).catch(() => false),
      }
    },

    async start() {},

    readConfigText: () => call('readConfigText', []),

    writeConfigText(text) {
      return call('writeConfigText', [text]).catch(() => false)
    },

    onConfigTextChange(cb) {
      configTextCallbacks.add(cb)
      return () => configTextCallbacks.delete(cb)
    },

    readUserCss: () => call('readUserCss', []),

    writeUserCss(text) {
      return call('writeUserCss', [text]).catch(() => false)
    },

    onUserCssChange(cb) {
      userCssCallbacks.add(cb)
      return () => userCssCallbacks.delete(cb)
    },

    fetch(input, init) {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const serialInit = /** @type {import('./rpc').SerialFetchInit} */ ({})
      if (init?.method) serialInit.method = init.method
      if (init?.body && typeof init.body === 'string')
        serialInit.body = init.body
      if (init?.headers) {
        const headers = /** @type {Record<string, string>} */ ({})
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
      return call('fetch', [url, serialInit]).then(
        (r) =>
          // these statuses need a null body or the constructor throws
          new Response(
            [101, 204, 205, 304].includes(r.status) ? null : r.body,
            {
              status: r.status,
              statusText: r.statusText,
              headers: r.headers,
            }
          )
      )
    },

    warnOutdated() {
      alert(
        '[Taut] This Taut extension is too old for the current Taut, so Slack will load without it.\n\nUpdate it: https://taut.jer.app'
      )
    },
  }
})()
