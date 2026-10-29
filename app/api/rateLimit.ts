import { getActiveTeamId } from '../slack/localConfig'

export type RateLimitOptions = {
  /** requests allowed in each window */
  max: number
  /** in ms */
  window: number
}

/** at most `max` requests per `window`, counted across every tab and plugin on the workspace that uses `key` */
export class RateLimit {
  constructor(
    readonly key: string,
    readonly options: RateLimitOptions
  ) {}

  /** takes a request if the window has room and resolves 0, or resolves the ms until it has room */
  take(): Promise<number> {
    const { max, window } = this.options
    const lock = `taut:rate-limit:${getActiveTeamId()}:${this.key}`
    return navigator.locks.request(lock, () => {
      const now = Date.now()
      let sent: number[] = []
      try {
        sent = JSON.parse(localStorage.getItem(lock) ?? '[]')
      } catch {}
      sent = sent.filter((at) => at > now - window)
      if (sent.length >= max) return sent[sent.length - max] + window - now
      localStorage.setItem(lock, JSON.stringify([...sent, now]))
      return 0
    })
  }

  /** resolves once it takes a request, rejects if `signal` aborts first */
  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    let wait = await this.take()
    while (wait) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, wait)
        const onAbort = () => {
          clearTimeout(timer)
          reject(signal?.reason)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      wait = await this.take()
    }
  }
}
