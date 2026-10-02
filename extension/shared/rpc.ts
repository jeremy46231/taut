// Extension bridge RPC types

import type { TautCookie } from '../../shared/TautBridge'

export type SerialFetchInit = {
  method?: string
  body?: string
  headers?: Record<string, string>
}
/** what the page gets from the content script */
export type SerialFetchResponse = {
  status: number
  statusText: string
  headers: Record<string, string>
  body: Uint8Array<ArrayBuffer>
}
/** Chrome's background -> content script form, runtime messaging there is JSON so the body is base64 */
export type WireFetchResponse = Omit<SerialFetchResponse, 'body'> & {
  body: string
}

export type ExtensionRpc = {
  readConfigText: () => Promise<string>
  writeConfigText: (text: string) => Promise<boolean>
  readUserCss: () => Promise<string>
  writeUserCss: (text: string) => Promise<boolean>
  readSecret: (key: string) => Promise<string | null>
  writeSecret: (key: string, value: string) => Promise<boolean>
  deleteSecret: (key: string) => Promise<boolean>
  listUserPlugins: () => Promise<string[]>
  readUserPlugin: (id: string) => Promise<string | null>
  writeUserPlugin: (id: string, code: string) => Promise<boolean>
  deleteUserPlugin: (id: string) => Promise<boolean>
  blobList: (namespace: string) => Promise<string[]>
  blobRead: (namespace: string, key: string) => Promise<string | null>
  blobWrite: (namespace: string, key: string, value: string) => Promise<boolean>
  blobDelete: (namespace: string, key: string) => Promise<boolean>
  blobClear: (namespace: string) => Promise<boolean>
  cookieGet: (details: {
    url: string
    name: string
  }) => Promise<TautCookie | null>
  cookieGetAll: (details: {
    url?: string
    domain?: string
    name?: string
  }) => Promise<TautCookie[]>
  cookieSet: (cookie: TautCookie & { url: string }) => Promise<boolean>
  cookieRemove: (details: { url: string; name: string }) => Promise<boolean>
  fetch: (url: string, init: SerialFetchInit) => Promise<SerialFetchResponse>
}

/** Chrome's background side of ExtensionRpc, with fetch in its wire form */
export type BackgroundRpc = Omit<ExtensionRpc, 'fetch'> & {
  fetch: (url: string, init: SerialFetchInit) => Promise<WireFetchResponse>
}

export type RpcMethod = keyof ExtensionRpc
export type RpcArgs<M extends RpcMethod> = Parameters<ExtensionRpc[M]>
export type RpcResult<M extends RpcMethod> = Awaited<
  ReturnType<ExtensionRpc[M]>
>

export type RpcRequest = {
  __taut: true
  kind: 'rpc'
  id: number
  method: RpcMethod
  args: unknown[]
}

export type RpcResultMessage = {
  __taut: true
  kind: 'rpc:result'
  id: number
} & ({ ok: true; value: unknown } | { ok: false; error: string })

export type BridgeEvent = {
  __taut: true
  kind: 'event'
} & (
  | {
      name: 'storage.changed'
      payload: { key: string; newValue: string | null }
    }
  | {
      name: 'userPlugin.changed'
      payload: { id: string; code: string | null }
    }
)
