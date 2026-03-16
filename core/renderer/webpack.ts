// Taut Webpack Utilities
// Provides utilities for finding Slack's internal Webpack modules
// Exposes React and ReactDOM for plugins

const global = globalThis as any

const webpackChunkwebapp = global.webpackChunkwebapp
let __webpack_require__: any
webpackChunkwebapp.push([
  [Symbol()],
  {},
  (r: any) => {
    __webpack_require__ = r
  },
])

export function allExports() {
  return (webpackChunkwebapp as any[])
    .flatMap((chunk: any) => Object.keys(chunk[1]))
    .map((id: string) => {
      try {
        return [id, __webpack_require__(id)] as const
      } catch {}
    })
    .filter((exp): exp is [string, any] => exp && exp[1])
}

type filter = (exp: any) => boolean

/**
 * Find Webpack exports matching a filter function
 * @param filter - Filter function to match exports
 * @param all - Whether to return all matches or just the first (default: false)
 */
export function findExport(filter: filter, all?: false): any | null
export function findExport(filter: filter, all: true): any[]
export function findExport(filter: filter, all = false) {
  const exports = allExports()
  const results = new Set<any>()

  for (const [id, exp] of exports) {
    try {
      if (filter(exp)) {
        if (!all) return exp
        results.add(exp)
      }
    } catch {}
    for (const key in exp) {
      if (!Object.prototype.hasOwnProperty.call(exp, key)) continue
      try {
        const candidate = exp[key]
        if (filter(candidate)) {
          if (!all) return candidate
          results.add(candidate)
        }
      } catch {}
    }
  }
  return all ? [...results] : null
}

/**
 * Find Webpack exports by their properties
 * @param props - Array of property names to match
 * @param all - Whether to return all matches or just the first (default: false)
 */
export function findByProps(props: string[], all?: false): any | null
export function findByProps(props: string[], all: true): any[]
export function findByProps(props: string[], all = false) {
  const func = (exp: any) => props.every((prop) => prop in exp)

  if (all) {
    return findExport(func, true)
  } else {
    return findExport(func)
  }
}

// Set the locale for dates for moment.js and expose it to work anywhere
export const moment = findByProps(['isMoment']) as typeof import('moment')
findByProps(['isMoment']).locale(window.navigator.language)
global.moment = moment // Expose moment globally for plugins

export const React = findByProps([
  'createElement',
  'Component',
  'useState',
]) as typeof import('react')
global.React = React // Makes JSX work anywhere

export const ReactDOM = findByProps([
  'render',
  'createPortal',
]) as typeof import('react-dom')
export const ReactDOMClient = findByProps([
  'createRoot',
  'hydrateRoot',
]) as typeof import('react-dom/client')

/**
 * Commonly used modules exposed for plugins
 */
export const commonModules = {
  /** npm:react */
  React,
  /** npm:react-dom */
  ReactDOM,
  /** npm:react-dom/client */
  ReactDOMClient,
}

// Expose for debugging in console
global.__webpack_require__ = __webpack_require__
global.allExports = allExports
global.findExport = findExport
global.findByProps = findByProps
