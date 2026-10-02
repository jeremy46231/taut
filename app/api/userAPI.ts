import { getActiveTeam } from '../slack/localConfig'

export interface UserAPIOptions {
  rateLimitRetries?: number
  signal?: AbortSignal
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** calls a Slack Web API method as the active user, throws if the request or the call fails */
export async function userAPI<T = any>(
  method: string,
  params: Record<string, string | Blob> = {},
  options: UserAPIOptions = {}
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

  const retries = options.rateLimitRetries ?? 0
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url.toString(), {
      method: 'POST',
      credentials: 'include',
      body,
      signal: options.signal,
    })

    if (res.status === 429) {
      if (attempt >= retries)
        throw new Error(`[Taut] userAPI ${method} rate limited`)
      const header = Number(res.headers.get('Retry-After'))
      const waitSec = Number.isFinite(header) && header > 0 ? header : 2
      await sleep(waitSec * 1000, options.signal)
      continue
    }

    if (!res.ok) {
      let text = ''
      try {
        text = await res.text()
      } catch {}
      throw new Error(`[Taut] userAPI ${method} HTTP ${res.status}: ${text}`)
    }

    const json = (await res.json()) as { ok: boolean } & Record<string, unknown>
    if (!json.ok) {
      // careful, slack maybe gives rate limits with a 200 and an error string
      if (json.error === 'ratelimited' || json.error === 'rate_limited') {
        if (attempt < retries) {
          await sleep(2000, options.signal)
          continue
        }
      }
      throw new Error(
        `[Taut] userAPI ${method} failed: ${JSON.stringify(json)}`
      )
    }

    return json as { ok: true } & T
  }
}
