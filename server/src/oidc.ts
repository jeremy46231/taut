// checks a GitHub Actions OIDC token (https://docs.github.com/en/actions/concepts/security/openid-connect)

const ISSUER = 'https://token.actions.githubusercontent.com'
const AUDIENCE = 'https://taut.jer.app'
// jeremy46231/taut by id
const REPOSITORY_ID = '1104578105'
const WORKFLOW =
  'jeremy46231/taut/.github/workflows/release.yml@refs/heads/main'

type Jwk = JsonWebKey & { kid: string }
let jwks: { keys: Jwk[]; fetched: number } | null = null

async function signingKey(kid: string): Promise<CryptoKey | null> {
  // github rotates keys, so an unknown kid refetches the JWKS (at most once a minute)
  const known = jwks?.keys.some((k) => k.kid === kid)
  if (!jwks || Date.now() - jwks.fetched > (known ? 3600_000 : 60_000)) {
    const response = await fetch(`${ISSUER}/.well-known/jwks`)
    if (!response.ok) throw new Error(`jwks: HTTP ${response.status}`)
    const { keys } = (await response.json()) as { keys: Jwk[] }
    jwks = { keys, fetched: Date.now() }
  }
  const jwk = jwks.keys.find((k) => k.kid === kid)
  if (!jwk) return null
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  )
}

const base64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0)
  )

const decode = (part: string) =>
  JSON.parse(new TextDecoder().decode(base64url(part)))

/** returns null if `authorization` is a valid token from release.yml on main, else why it isn't */
export async function checkReleaseToken(
  authorization: string | null
): Promise<string | null> {
  const token = authorization?.match(/^Bearer (\S+)$/)?.[1]
  if (!token) return 'no bearer token'
  const [header, payload, signature] = token.split('.')
  if (!header || !payload || !signature) return 'not a jwt'

  let claims: Record<string, unknown>
  let key: CryptoKey | null
  try {
    const { alg, kid } = decode(header)
    if (alg !== 'RS256' || typeof kid !== 'string') return 'not RS256'
    key = await signingKey(kid)
    claims = decode(payload)
  } catch {
    return 'unreadable token'
  }
  if (!key) return 'unknown key'
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64url(signature),
    new TextEncoder().encode(`${header}.${payload}`)
  )
  if (!valid) return 'bad signature'

  const now = Date.now() / 1000
  if (claims.iss !== ISSUER) return 'wrong issuer'
  if (claims.aud !== AUDIENCE) return 'wrong audience'
  if (typeof claims.exp !== 'number' || claims.exp < now) return 'expired'
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60)
    return 'not valid yet'
  if (String(claims.repository_id) !== REPOSITORY_ID) return 'wrong repository'
  if (claims.workflow_ref !== WORKFLOW) return 'wrong workflow'
  return null
}
