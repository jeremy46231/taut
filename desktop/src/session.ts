// Taut Desktop Session Setup

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { session } from 'electron'

declare const __TAUT_EMBEDDED__: boolean

export function setupSession(realResourcesPath: string) {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['*://*/apps/sentryproxy/*'] },
    (_details, callback) => callback({ cancel: true })
  )

  if (__TAUT_EMBEDDED__) {
    const tautJsPath = path.join(realResourcesPath, 'taut.js')

    session.defaultSession.protocol.handle('taut', (request) => {
      const url = new URL(request.url)
      const file = url.pathname.replace(/^\//, '')

      if (file === 'app/taut.js' || file === 'taut.js') {
        try {
          return new Response(readFileSync(tautJsPath), {
            headers: { 'Content-Type': 'application/javascript' },
          })
        } catch {
          return new Response('console.error("[Taut] taut.js not found")', {
            status: 200,
            headers: { 'Content-Type': 'application/javascript' },
          })
        }
      }

      return new Response('Not found', { status: 404 })
    })
  }
}
