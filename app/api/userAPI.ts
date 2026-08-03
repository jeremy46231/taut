// Calls the Slack Web API as the current user

import { getActiveTeam } from './localConfig'

/**
 * Call a Slack Web API method as the currently-active user and return the
 * parsed JSON response. Throws if the request or the API call fails
 */
export async function userAPI<T = any>(
  method: string,
  params: Record<string, string | Blob> = {}
): Promise<{ ok: true } & T> {
  const team = getActiveTeam()
  if (!team?.token || !team?.url)
    throw new Error('[Taut] No active Slack team/token for userAPI')

  const url = new URL(`api/${method}`, team.url)
  url.searchParams.set('_x_gantry', 'true') // apparently makes the server return CORS headers we need

  const body = new FormData()
  body.set('token', team.token)
  for (const [name, value] of Object.entries(params)) {
    body.set(name, value)
  }

  const res = await fetch(url.toString(), {
    method: 'POST',
    credentials: 'include',
    body,
  })
  if (!res.ok) {
    let text = ''
    try {
      text = await res.text()
    } catch {}
    throw new Error(`[Taut] userAPI ${method} HTTP ${res.status}: ${text}`)
  }

  const json = (await res.json()) as { ok: boolean } & Record<string, any>
  if (!json.ok)
    throw new Error(`[Taut] userAPI ${method} failed: ${JSON.stringify(json)}`)

  return json as { ok: true } & T
}
