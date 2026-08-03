// Taut Firefox content script

window.addEventListener('message', async (event) => {
  if (event.source !== window) return
  const msg = event.data
  if (!msg?.__taut || msg.kind !== 'rpc') return

  let result
  try {
    result = await browser.runtime.sendMessage({
      method: msg.method,
      args: msg.args,
    })
  } catch (e) {
    result = { ok: false, error: String(e) }
  }
  window.postMessage({
    __taut: true,
    kind: 'rpc:result',
    id: msg.id,
    ...result,
  })
})

// Forward storage changes (this or another tab) to the page as events
const CONTENT_USER_PLUGIN_PREFIX = 'taut-user-plugin:'
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key.startsWith(CONTENT_USER_PLUGIN_PREFIX)) {
      window.postMessage({
        __taut: true,
        kind: 'event',
        name: 'userPlugin.changed',
        payload: {
          id: key.slice(CONTENT_USER_PLUGIN_PREFIX.length),
          code: newValue ?? null,
        },
      })
      continue
    }
    window.postMessage({
      __taut: true,
      kind: 'event',
      name: 'storage.changed',
      payload: { key, newValue: newValue ?? null },
    })
  }
})
