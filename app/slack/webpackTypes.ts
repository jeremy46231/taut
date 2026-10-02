export type Exports = Record<string, any>

export type WebpackModule = {
  id: PropertyKey
  loaded: boolean
  exports: Exports
}

export type ModuleFactory = (
  module: WebpackModule,
  exports: Exports,
  require: WebpackRequire
) => void

export type Chunk = [
  PropertyKey[],
  Record<PropertyKey, ModuleFactory>,
  ((require: WebpackRequire) => any)?,
]

export interface WebpackRequire {
  (id: PropertyKey): Exports

  m: Record<PropertyKey, ModuleFactory>

  /** throws when indirect AMD define is used */
  amdD: () => never

  /** placeholder AMD object */
  amdO: Record<string, any>

  /** queues and runs chunks, with an optional priority, returning the result if there is one */
  O: <T>(
    returnValue: T,
    chunkIds?: PropertyKey[],
    execute?: () => T,
    priority?: number
  ) => T | undefined

  /** a getter for a module's default export */
  n: <T extends object>(module: T) => (() => any) & { a: () => any }

  /** converts a module to a namespace object according to runtime flags */
  t: (module: any, flags: number) => Exports

  /** defines getters for module exports properties */
  d: (exports: Exports, definition: Record<string, () => any>) => void

  f: {
    /** ensures a JS chunk is loaded, adding its promise to the array */
    j: (chunkId: PropertyKey, promises: Promise<undefined[]>) => void
    /** ensures a CSS chunk is loaded, adding its promise to the array */
    miniCss: (chunkId: PropertyKey, promises: Promise<undefined[]>) => void
    /** prefetches more chunks after this chunk is loaded */
    prefetch?: (chunkId: PropertyKey, promises: Promise<undefined[]>) => void
  }

  /** ensures a JS chunk is loaded */
  e: (chunkId: PropertyKey) => Promise<undefined[]>

  /** a JS chunk's URL */
  u: (chunkId: PropertyKey) => string | undefined

  /** a CSS chunk's URL */
  miniCssF: (chunkId: PropertyKey) => string

  g: typeof globalThis

  /** shorthand for Object.prototype.hasOwnProperty */
  o: (obj: object, prop: PropertyKey) => boolean

  /** inserts a script tag and calls back on load or error */
  l: (
    url: string,
    callback: (err?: Event | { type?: string }) => void,
    chunkId?: PropertyKey,
    extra1?: any,
    extra2?: any,
    extra3?: any
  ) => void

  /** marks an object as an ES module */
  r: (exports: object) => void

  /** normalizes a non-AMD module with paths and children arrays */
  nmd: <T extends { paths?: string[]; children?: any[] }>(module: T) => T

  /** base URL for resolving chunks */
  p: string
}

declare global {
  var webpackChunkwebapp: Array<Chunk>
}
