import { Store } from '../store'
import {
  findModuleId,
  forEachExport,
  getExport,
  getValueSource,
  onModuleLoaded,
  waitForExport,
} from './webpack'

const global = globalThis as any

declare global {
  namespace React {
    interface Attributes {
      __original?: true
    }
  }
}

function isReact(exp: any): exp is typeof import('react') {
  return (
    exp &&
    typeof exp === 'object' &&
    'createElement' in exp &&
    'Component' in exp &&
    'useState' in exp
  )
}

function isJsxRuntime(exp: any): boolean {
  return !!(
    exp &&
    typeof exp === 'object' &&
    exp.jsx &&
    exp.jsxs &&
    exp.Fragment
  )
}

type filter = (exp: any) => boolean

/** every name a component lookup finds `exp` by */
function lookupNames(exp: any): unknown[] {
  if (typeof exp === 'function') return [exp.displayName, exp.name]
  if (!exp || typeof exp !== 'object') return []
  if (exp.$$typeof === Symbol.for('react.memo'))
    return [exp.displayName, getComponentName(exp.type)]
  if (exp.$$typeof === Symbol.for('react.forward_ref'))
    return [exp.displayName, exp.render?.displayName, exp.render?.name]
  return []
}

function componentFilter(name: string, filter?: filter) {
  return (exp: any) =>
    lookupNames(exp).includes(name) && (!filter || filter(exp))
}

// names looked up without a filter, each distinct component they find -> its export
const unfilteredLookups = new Map<string, Map<unknown, unknown>>()
let scanPending = false

function noteLookupMatch(exp: unknown) {
  for (const name of lookupNames(exp)) {
    const found = typeof name === 'string' && unfilteredLookups.get(name)
    if (!found) continue
    const layers = unwrapComponentLayers(exp)
    const component = layers[layers.length - 1]
    if (found.has(component)) continue
    found.set(component, exp)
    if (found.size === 2)
      console.warn(
        `[Taut] More than one component is named "${name}", look it up with a filter:`,
        [...found.values()]
      )
  }
}

/** warns once a second component turns up under `name` */
function watchForDuplicates(name: string) {
  if (unfilteredLookups.has(name)) return
  unfilteredLookups.set(name, new Map())
  if (scanPending) return
  scanPending = true
  // a full scan takes tens of ms, so one idle scan covers each burst of lookups
  requestIdleCallback(() => {
    scanPending = false
    getExport((exp) => {
      noteLookupMatch(exp)
      return false
    }, true)
  })
}

onModuleLoaded((exports) => {
  if (!unfilteredLookups.size) return
  noteLookupMatch(exports)
  if (!exports || typeof exports !== 'object') return
  for (const key in exports) {
    if (!Object.hasOwn(exports, key)) continue
    try {
      noteLookupMatch(exports[key])
    } catch {}
  }
})

const MISSING_MS = 30_000

/**
 * renders nothing until the component turns up
 * if you use this, consider moving it to `api.elements`
 */
export function lazyComponent<P extends {}>(
  name: string,
  filter?: filter
): React.ComponentType<P> {
  if (!filter) watchForDuplicates(name)
  const match = componentFilter(name, filter)
  const component = new Store<React.ComponentType<P> | undefined>(undefined)
  let looked = false

  const look = () => {
    if (looked) return
    looked = true
    const loaded = getExport<React.ComponentType<P>>(match)
    if (loaded) {
      component.set(loaded)
      return
    }
    waitForExport<React.ComponentType<P>>(match).then(component.set)
    setTimeout(() => {
      if (!component.get()) console.error(`[Taut] "${name}" is unavailable`)
    }, MISSING_MS)
  }

  function LazyComponent(props: P) {
    // resolving on the first render keeps an already-loaded component from flashing
    look()
    const Component = component.use()
    return Component ? <Component {...props} /> : null
  }
  LazyComponent.displayName = `Lazy(${name})`
  return LazyComponent
}

/** resolves whenever the component turns up, for use outside a render */
export function waitForComponent<P extends {}>(
  name: string,
  filter?: filter
): Promise<React.ComponentType<P>> {
  if (!filter) watchForDuplicates(name)
  return waitForExport<React.ComponentType<P>>(componentFilter(name, filter))
}

/** throws if the component's chunk hasn't loaded yet */
export function getComponent<P extends {}>(
  name: string,
  all?: false,
  filter?: filter
): React.ComponentType<P>
export function getComponent<P extends {}>(
  name: string,
  all: true,
  filter?: filter
): React.ComponentType<P>[]
export function getComponent(name: string, all = false, filter?: filter) {
  const func = componentFilter(name, filter)

  if (all) return getExport(func, true)
  if (!filter) watchForDuplicates(name)
  const result = getExport(func)
  if (!result) throw new Error(`[Taut] Could not find component: ${name}`)
  return result
}
global.waitForComponent = waitForComponent
global.getComponent = getComponent

// many components aren't exported and connect drops WrappedComponent, so record what resolveType sees
const renderedComponents = new Map<string, ComponentType>()
const renderedWaiters = new Map<string, Set<(c: ComponentType) => void>>()

function rememberRendered(type: any) {
  const name = getComponentName(type)
  if (!name || renderedComponents.has(name)) return
  renderedComponents.set(name, type)

  const waiters = renderedWaiters.get(name)
  if (!waiters) return
  renderedWaiters.delete(name)
  for (const resolve of waiters) resolve(type)
}

/** only knows what has been on screen, unlike getComponent which reads exports (avoid if you can) */
export function getRenderedComponent(name: string): ComponentType | undefined {
  return renderedComponents.get(name)
}

/** for components Slack never exports, which resolve once something mounts one (avoid if you can) */
export function waitForRenderedComponent(name: string): Promise<ComponentType> {
  const seen = renderedComponents.get(name)
  if (seen) return Promise.resolve(seen)

  return new Promise((resolve) => {
    let waiters = renderedWaiters.get(name)
    if (!waiters) {
      waiters = new Set()
      renderedWaiters.set(name, waiters)
    }
    waiters.add(resolve)
  })
}

global.lazyComponent = lazyComponent
global.getRenderedComponent = getRenderedComponent
global.waitForRenderedComponent = waitForRenderedComponent
global.renderedComponents = renderedComponents

export function getFiberFromNode(node: Element): any | null {
  const key = Object.keys(node).find(
    (k) =>
      k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
  )
  if (!key) return null
  return (node as any)[key]
}
global.getFiberFromNode = getFiberFromNode

export type ComponentType<P = any> = React.ComponentType<P> | string

function getComponentName(component: any): string | null {
  if (!component) return null

  if (typeof component === 'object') {
    if (component.$$typeof === Symbol.for('react.memo')) {
      return getComponentName(component.type)
    }
    if (component.$$typeof === Symbol.for('react.forward_ref')) {
      return (
        component.displayName ||
        component.render?.displayName ||
        component.render?.name ||
        null
      )
    }
    if (component.$$typeof === Symbol.for('taut.originalComponent')) {
      return component.displayName || null
    }
  }

  if (typeof component === 'function') {
    return component.displayName || component.name || null
  }

  return null
}

function unwrapComponentLayers(component: any): any[] {
  const layers: any[] = []
  let current = component
  while (current && layers.length < 10) {
    layers.push(current)
    if (isOriginalComponentObject(current)) {
      current = current.originalComponent
    } else if (wrapperOriginals.has(current)) {
      current = wrapperOriginals.get(current)
    } else if (typeof current === 'object') {
      if (current.$$typeof === Symbol.for('react.memo')) {
        current = current.type
      } else if (current.$$typeof === Symbol.for('react.forward_ref')) {
        current = current.render
      } else {
        break
      }
    } else {
      break
    }
  }
  return layers
}

/** tries for the whole module's source, falls back to the function's own */
export function getComponentSource(component: ComponentType): string {
  if (typeof component === 'string') {
    throw new Error(`[Taut] "${component}" is a host element, not a component`)
  }
  const layers = unwrapComponentLayers(component)
  for (const layer of layers) {
    if (findModuleId(layer) !== undefined) return getValueSource(layer)
  }
  const innermost = layers[layers.length - 1]
  if (typeof innermost === 'function') return innermost.toString()
  throw new Error(`[Taut] Could not find source for component`, {
    cause: component,
  })
}
global.getComponentSource = getComponentSource

function getDisplayName(component: ComponentType): string {
  if (typeof component === 'string') return component
  const name = getComponentName(component)
  if (name) return name
  return 'Component'
}

type componentMatcher = (component: ComponentType) => boolean
export type componentReplacer<P = any> = (
  OriginalComponent: ComponentType<P>
) => ComponentType<P>

const componentReplacements = new Map<componentMatcher, componentReplacer>()

// components seen since the last patch change that match no replacer
let notPatchedCache = new WeakSet<object>()

// saved by bootstrap so a name's wrapper exists before the plugin that patches it starts
export const patchTargets = new Store<ReadonlySet<string>>(new Set())

export function addPatchTargets(names: Iterable<string>): void {
  const next = new Set(patchTargets.get())
  for (const name of names) next.add(name)
  if (next.size === patchTargets.get().size) return
  patchTargets.set(next)
  notPatchedCache = new WeakSet<object>()
}

const originalComponentSymbol = Symbol.for('taut.originalComponent')

const originalComponentObjectCache = new WeakMap<any, originalComponentObject>()
type originalComponentObject = {
  $$typeof: typeof originalComponentSymbol
  originalComponent: ComponentType
  displayName: string
}

function getOriginalComponentObject(
  component: ComponentType
): originalComponentObject {
  if (originalComponentObjectCache.has(component)) {
    return originalComponentObjectCache.get(
      component
    ) as originalComponentObject
  }
  const obj: originalComponentObject = {
    $$typeof: originalComponentSymbol,
    originalComponent: component,
    displayName: getDisplayName(component),
  }
  originalComponentObjectCache.set(component, obj)
  return obj
}

function isOriginalComponentObject(
  component: any
): component is originalComponentObject {
  return (
    typeof component === 'object' &&
    component !== null &&
    component.$$typeof === originalComponentSymbol &&
    'originalComponent' in component
  )
}

const notHoisted = new Set([
  'length',
  'name',
  'prototype',
  'caller',
  'callee',
  'arguments',
  'displayName',
  'defaultProps',
  'propTypes',
  'contextType',
  'contextTypes',
  'childContextTypes',
  'getDerivedStateFromProps',
  'getDerivedStateFromError',
  '$$typeof',
  'type',
  'render',
  'compare',
])

function hoistStatics(replaced: any, original: any): void {
  const holds = (value: any) =>
    value && (typeof value === 'function' || typeof value === 'object')
  if (!holds(replaced) || !holds(original)) return
  for (const key of Object.getOwnPropertyNames(original)) {
    if (notHoisted.has(key) || Object.hasOwn(replaced, key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(original, key)
    if (!descriptor) continue
    try {
      Object.defineProperty(replaced, key, descriptor)
    } catch {}
  }
}

const replacerResultCache = new WeakMap<
  componentReplacer,
  Map<ComponentType, ComponentType>
>()

function applyReplacerWithCache<P = any>(
  replacer: componentReplacer<P>,
  originalComponent: ComponentType<P>
): ComponentType<P> {
  let resultCache = replacerResultCache.get(replacer)
  if (!resultCache) {
    resultCache = new Map<ComponentType, ComponentType>()
    replacerResultCache.set(replacer, resultCache)
  }
  if (resultCache.has(originalComponent)) {
    return resultCache.get(originalComponent) as ComponentType<P>
  }

  const replaced = replacer(originalComponent)
  if (typeof replaced === 'function' && !('displayName' in replaced)) {
    replaced.displayName = `Patched(${getDisplayName(originalComponent)})`
  }

  resultCache.set(originalComponent, replaced)
  return replaced
}

// each matched or ever-patched component gets one permanent wrapper, so later patches rerender in place

type wrappedComponent = {
  Wrapper: React.ComponentType<any>
  composed: Store<ComponentType>
}
const wrappedComponents = new Map<object, wrappedComponent>()
const wrapperOriginals = new WeakMap<object, any>()
// what wrappers render
const composedComponents = new WeakSet<object>()

function matchingReplacers(type: ComponentType): componentReplacer[] {
  return [...componentReplacements.entries()]
    .filter(([matcher]) => matcher(type))
    .map(([, replacer]) => replacer)
}

/** the original wrapped in every matching replacer, or the original itself */
function composeComponent(type: ComponentType): ComponentType {
  const original = getOriginalComponentObject(type) as unknown as ComponentType
  const replacers = matchingReplacers(type)
  if (replacers.length === 0) return original
  const composed = replacers.reduce(
    (current, replacer) => applyReplacerWithCache(replacer, current),
    original
  )
  if (typeof composed === 'object' || typeof composed === 'function') {
    composedComponents.add(composed)
  }
  return composed
}

function wrapComponent(type: object): wrappedComponent {
  const composed = new Store<ComponentType>(composeComponent(type as any))
  function Wrapped(props: any) {
    const Component = composed.use()
    return <Component {...props} />
  }
  Wrapped.displayName = `Wrapped(${getDisplayName(type as any)})`
  hoistStatics(Wrapped, type)
  const entry = { Wrapper: Wrapped, composed }
  wrappedComponents.set(type, entry)
  wrapperOriginals.set(Wrapped, type)
  return entry
}

/** brings every wrapper in line with the current replacers */
function applyPatches() {
  notPatchedCache = new WeakSet<object>()
  for (const [type, { composed }] of wrappedComponents) {
    const next = composeComponent(type as any)
    if (next !== composed.get()) composed.set(next)
  }
}

// returns the type itself, its wrapper, or the component behind an original-component object
function resolveType(type: any, props: any): any {
  // `__original` opts one render out of patching, but prefer the original component object so patches stack
  const __original = props?.__original
  if (__original) {
    delete props.__original
    return type
  }

  if (isOriginalComponentObject(type)) return type.originalComponent

  if (type === null || (typeof type !== 'object' && typeof type !== 'function'))
    return type
  if (composedComponents.has(type) || notPatchedCache.has(type)) return type
  const wrapped = wrappedComponents.get(type)
  if (wrapped) return wrapped.Wrapper

  // past the caches, so this is the first time we've seen this component
  rememberRendered(type)

  const name = getComponentName(type)
  if (
    (name !== null && patchTargets.get().has(name)) ||
    matchingReplacers(type).length > 0
  ) {
    return wrapComponent(type).Wrapper
  }

  notPatchedCache.add(type)
  return type
}

function patchComponent<P = object>(
  matcher:
    | string
    | { displayName?: string; filter?: filter; component?: ComponentType<P> },
  replacement: componentReplacer<P>
): () => void {
  const displayName =
    typeof matcher === 'string' ? matcher : matcher.displayName
  const filter = typeof matcher === 'string' ? undefined : matcher.filter
  const component = typeof matcher === 'string' ? undefined : matcher.component

  const matcherFunc: componentMatcher = (comp: any) => {
    if (component && comp === component) return true
    if (displayName === undefined && !filter) return false
    if (displayName !== undefined && getComponentName(comp) !== displayName) {
      return false
    }
    if (filter && !filter(comp)) return false
    return true
  }

  componentReplacements.set(matcherFunc, replacement)
  if (displayName !== undefined) addPatchTargets([displayName])
  applyPatches()
  return () => {
    componentReplacements.delete(matcherFunc)
    applyPatches()
  }
}

const renderWrappers = new WeakSet<object>()
/** `render` resolving its type first, or `render` itself if it already does (a second resolve would drop `__original`) */
function resolvingType<
  F extends (type: any, props: any, ...rest: any[]) => any,
>(render: F): F {
  if (typeof render !== 'function' || renderWrappers.has(render)) return render
  const wrapper = ((type: any, props: any, ...rest: any[]) =>
    render(resolveType(type, props), props, ...rest)) as F
  renderWrappers.add(wrapper)
  return wrapper
}

// Slack can expose the same React from more than one export object
export const reactPromise: Promise<typeof import('react')> = new Promise(
  (resolve) => {
    forEachExport(isReact, (React) => {
      React.createElement = resolvingType(React.createElement)
      global.React = React
      resolve(React)
    })
  }
)

const jsxRuntimePromise: Promise<void> = new Promise((resolve) => {
  forEachExport(isJsxRuntime, (rt) => {
    rt.jsx = resolvingType(rt.jsx)
    rt.jsxs = resolvingType(rt.jsxs)
    resolve()
  })
})

export const patchComponentPromise = (async () => {
  await reactPromise
  await jsxRuntimePromise
  global.patchComponent = patchComponent
  return patchComponent
})()
