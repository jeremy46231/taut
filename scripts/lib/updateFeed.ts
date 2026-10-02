// update ymls name files relative to the feed, so each is swapped for its immutable `desktop-v*` release asset

// `  - url: taut-mac.zip` in `files:`, and the legacy top-level `path:`
const FILE_LINE = /^(\s*(?:- )?(?:url|path):[ \t]*)(['"]?)([^'"\n]+)\2[ \t]*$/gm

function feedFiles(yml: string): string[] {
  return [...new Set([...yml.matchAll(FILE_LINE)].map((m) => m[3]))]
}

/** null when a file isn't in `assets` (a partly published release) */
export function rewriteFeed(
  yml: string,
  assets: ReadonlyMap<string, string>
): string | null {
  const files = feedFiles(yml)
  if (files.length === 0 || files.some((name) => !assets.has(name))) {
    return null
  }
  return yml.replace(
    FILE_LINE,
    (_, key: string, _quote: string, name: string) =>
      `${key}${JSON.stringify(assets.get(name))}`
  )
}
