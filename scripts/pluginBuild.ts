// Shared compiler for bundled and user plugins.

const globalPluginShim = {
  name: 'global-plugin-shim',
  setup(build: any) {
    build.onResolve({ filter: /^\$taut$/ }, () => ({
      path: '$taut',
      namespace: 'taut-global',
    }))
    build.onLoad({ filter: /.*/, namespace: 'taut-global' }, () => ({
      contents: `
        export const TautPlugin = globalThis.TautPlugin
        export default TautPlugin
      `,
      loader: 'js',
    }))
  },
}

/** Bundle one plugin into the IIFE-returns-class format Taut loads. */
export async function bundlePlugin(
  entrypoint: string,
  debug = false
): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: 'browser',
    format: 'esm',
    minify: !debug,
    sourcemap: debug ? 'inline' : 'none',
    plugins: [globalPluginShim],
    define: { process: 'undefined' },
  })

  if (!result.success) {
    throw new AggregateError(result.logs, `Failed to bundle ${entrypoint}`)
  }

  let code = await result.outputs[0].text()
  code = `(() => {\n${code}\n})()`
  code = code.replace(/export\s*{\s*(\w+)\s+as\s+default\s*};?/g, 'return $1;')
  code = code.replace(/export\s+default\s+(\w+);?/g, 'return $1;')

  if (!/\breturn\s+[A-Za-z_$][\w$]*\s*;/.test(code)) {
    throw new Error('Plugin must have a named default-exported class')
  }
  return code
}
