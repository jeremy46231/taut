// Shared compiler for bundled and user plugins

import { build, type Plugin } from 'esbuild'

const globalPluginShim: Plugin = {
  name: 'global-plugin-shim',
  setup(build) {
    build.onResolve({ filter: /^\$taut$/ }, () => ({
      path: '$taut',
      namespace: 'taut-global',
    }))
    build.onLoad({ filter: /.*/, namespace: 'taut-global' }, () => ({
      contents: `
        export const TautPlugin = globalThis.TautPlugin
        export const opt = globalThis.TautOpt
        export default TautPlugin
      `,
      loader: 'js',
    }))
  },
}

/** bundles one plugin into the IIFE-returns-class format Taut loads */
export async function bundlePlugin(
  entrypoint: string,
  debug = false
): Promise<string> {
  const result = await build({
    entryPoints: [entrypoint],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    minify: !debug,
    sourcemap: debug ? 'inline' : false,
    plugins: [globalPluginShim],
    define: { process: 'undefined' },
  })

  let code = result.outputFiles[0].text
  code = `(() => {\n${code}\n})()`
  code = code.replace(/export\s*{\s*(\w+)\s+as\s+default\s*};?/g, 'return $1;')
  code = code.replace(/export\s+default\s+(\w+);?/g, 'return $1;')

  if (!/\breturn\s+[A-Za-z_$][\w$]*\s*;/.test(code)) {
    throw new Error('Plugin must have a named default-exported class')
  }
  return code
}
