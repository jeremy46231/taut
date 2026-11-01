// Taut Firefox content script

// parallel to extension/chrome/content.js

// if a service worker is running, drop it and reload (so the patch actually runs)
navigator.serviceWorker
  .getRegistrations()
  .then((registrations) =>
    Promise.all(registrations.map((r) => r.unregister()))
  )
  .then((unregistered) => {
    if (unregistered.includes(true) && navigator.serviceWorker.controller)
      location.reload()
  })
  .catch((e) =>
    console.warn("[Taut] Couldn't remove Slack's service worker:", e)
  )

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
    // bridge-setup.js reads only these, so plugin writes stay out of the page
    if (key !== 'taut-config' && key !== 'taut-user-css') continue
    window.postMessage({
      __taut: true,
      kind: 'event',
      name: 'storage.changed',
      payload: { key, newValue: newValue ?? null },
    })
  }
})
