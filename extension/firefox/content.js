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

// storage changes from this or another tab go to the page as events
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key.startsWith('taut-user-plugin:')) {
      window.postMessage({
        __taut: true,
        kind: 'event',
        name: 'userPlugin.changed',
        payload: {
          id: key.slice('taut-user-plugin:'.length),
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
