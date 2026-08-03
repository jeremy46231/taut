// Desktop bridge RPC types

import type { TautCookie } from '../../shared/TautBridge'

export type SerialFetchInit = {
  method?: string
  body?: string
  headers?: Record<string, string>
}

export type SerialFetchResponse = {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}

export type DesktopRpc = {
  fetch: (url: string, init: SerialFetchInit) => Promise<SerialFetchResponse>
  readConfigText: () => Promise<string>
  writeConfigText: (text: string) => Promise<boolean>
  readUserCss: () => Promise<string>
  writeUserCss: (text: string) => Promise<boolean>
  readSecret: (key: string) => Promise<string | null>
  writeSecret: (key: string, value: string) => Promise<boolean>
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
}

export type RpcMethod = keyof DesktopRpc
export type RpcArgs<M extends RpcMethod> = Parameters<DesktopRpc[M]>
export type RpcResult<M extends RpcMethod> = Awaited<ReturnType<DesktopRpc[M]>>
