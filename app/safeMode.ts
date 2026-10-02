// Taut Safe Mode: boots with no plugins or user CSS, to recover from a plugin that breaks Slack

/** call once at boot, it clears the one-shot flag */
export function consumeSafeMode(): boolean {
  let once = false
  try {
    once = sessionStorage.getItem('taut_safe_mode_once') !== null
    sessionStorage.removeItem('taut_safe_mode_once')
  } catch {}
  return once || new URLSearchParams(location.search).has('taut_safe_mode')
}

/** a sessionStorage flag survives Slack's router and the desktop app, and lasts one reload */
export function reloadInSafeMode() {
  try {
    sessionStorage.setItem('taut_safe_mode_once', '1')
  } catch {
    const url = new URL(location.href)
    url.searchParams.set('taut_safe_mode', '')
    location.replace(url)
    return
  }
  location.reload()
}

export function reloadWithoutSafeMode() {
  const url = new URL(location.href)
  if (!url.searchParams.has('taut_safe_mode')) {
    location.reload()
    return
  }
  url.searchParams.delete('taut_safe_mode')
  location.replace(url)
}
