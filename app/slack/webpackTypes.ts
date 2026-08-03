// Types for Slack's webpack runtime
// Describes the shapes we intercept in webpack.ts (chunks, module factories,
// the require function, etc.)

export type Exports = Record<string, any>

export type WebpackModule = {
  id: PropertyKey
  loaded: boolean
  exports: Exports
}

// Module definition function invoked when a module is required
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
  /** Load a module by ID and return its exports */
  (id: PropertyKey): Exports

  /** Map of all module definitions */
  m: Record<PropertyKey, ModuleFactory>

  /** Throws when indirect AMD define is used */
  amdD: () => never

  /** Placeholder AMD object */
  amdO: Record<string, any>

  /**
   * Queue and execute chunks. Can schedule execution with optional priority.
   * Returns the executed chunk's result if available.
   */
  O: <T>(
    returnValue: T,
    chunkIds?: PropertyKey[],
    execute?: () => T,
    priority?: number
  ) => T | undefined

  /** Returns accessor for default export of a module */
  n: <T extends object>(module: T) => (() => any) & { a: () => any }

  /** Convert a module to a namespace object according to runtime flags */
  t: (module: any, flags: number) => Exports

  /** Define getters for module exports properties */
  d: (exports: Exports, definition: Record<string, () => any>) => void

  f: {
    /** Ensure a JS chunk is loaded, adding its promise to the array */
    j: (chunkId: PropertyKey, promises: Promise<undefined[]>) => void
    /** Ensure a CSS chunk is loaded, adding its promise to the array */
    miniCss: (chunkId: PropertyKey, promises: Promise<undefined[]>) => void
    /** Prefetch additional chunks after this chunk is loaded */
    prefetch?: (chunkId: PropertyKey, promises: Promise<undefined[]>) => void
  }

  /** Ensure JS chunk is loaded, returns a promise */
  e: (chunkId: PropertyKey) => Promise<undefined[]>

  /** Get URL of JS chunk */
  u: (chunkId: PropertyKey) => string | undefined

  /** Get URL of CSS chunk */
  miniCssF: (chunkId: PropertyKey) => string

  /** Reference to globalThis */
  g: typeof globalThis

  /** Shorthand for Object.prototype.hasOwnProperty */
  o: (obj: object, prop: PropertyKey) => boolean

  /** Insert a script tag and invoke callback on load or error */
  l: (
    url: string,
    callback: (err?: Event | { type?: string }) => void,
    chunkId?: PropertyKey,
    extra1?: any,
    extra2?: any,
    extra3?: any
  ) => void

  /** Mark an object as an ES module */
  r: (exports: object) => void

  /** Normalize non-AMD module with paths and children arrays */
  nmd: <T extends { paths?: string[]; children?: any[] }>(module: T) => T

  /** Base URL for resolving chunks */
  p: string
}

declare global {
  var webpackChunkwebapp: Array<Chunk>
}
