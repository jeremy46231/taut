import type { TautCookie } from '../../shared/TautBridge'
import type { NormalizedBridge } from '../bridgeCompat'
import {
  getActiveTeam,
  type LocalConfigTeam,
  readLocalConfig,
} from '../slack/localConfig'

const SLACK_URL = 'https://app.slack.com'
export const SECRET_KEY = 'accounts'

export type StoredAccount = {
  userId: string
  teamId: string
  // the whole entry, enterprise boot needs `url` (the API host) or fails with `api_missing_host_error`
  team: LocalConfigTeam
  // the `d` cookie, the server rejects the team's xoxc token without it
  xoxd: string
  updatedAt: number
}

/** call at the very top of bootstrap(), before any await and before Slack's webpack reads `localConfig_v2` */
export function applyPendingSwitch(): void {
  let pendingJson: string | null
  try {
    // the account handed over by `switchTo` for this page load
    pendingJson = localStorage.getItem('taut:pendingSwitch')
  } catch {
    return
  }
  if (!pendingJson) return
  localStorage.removeItem('taut:pendingSwitch')

  let account: StoredAccount
  try {
    account = JSON.parse(pendingJson)
  } catch {
    return
  }
  if (!account.team?.token) return

  const localConfig = readLocalConfig()
  localConfig.teams ??= {}
  localConfig.teams[account.teamId] = {
    ...localConfig.teams[account.teamId],
    ...account.team,
  }
  localConfig.lastActiveTeamId = account.teamId
  localConfig.orderedTeamIds ??= []
  if (!localConfig.orderedTeamIds.includes(account.teamId))
    localConfig.orderedTeamIds.push(account.teamId)
  localStorage.setItem('localConfig_v2', JSON.stringify(localConfig))
  console.log(`[Taut] Applied pending account switch to ${account.userId}`)
}

export class AccountSwitcher {
  /** whether this loader can write the HttpOnly `d` cookie, which switching needs */
  readonly supported: boolean
  private readonly cookies: NormalizedBridge['cookies']

  constructor(private bridge: NormalizedBridge) {
    this.cookies = bridge.cookies ?? null
    this.supported = this.cookies != null
  }

  private async load(): Promise<Record<string, StoredAccount>> {
    try {
      return JSON.parse((await this.bridge.readSecret(SECRET_KEY)) || '{}')
    } catch {
      return {}
    }
  }

  private save(accounts: Record<string, StoredAccount>): Promise<boolean> {
    return this.bridge.writeSecret(SECRET_KEY, JSON.stringify(accounts))
  }

  async list(): Promise<StoredAccount[]> {
    return Object.values(await this.load())
  }

  /** removes a saved account without touching the live session */
  async forget(userId: string): Promise<void> {
    const accounts = await this.load()
    delete accounts[userId]
    await this.save(accounts)
  }

  /** drops saved accounts that fail auth.test, ones that can't be checked are in neither list */
  async validate(): Promise<{ kept: string[]; dropped: string[] }> {
    const accounts = await this.load()
    const checks = await Promise.all(
      Object.values(accounts).map(async (account) => ({
        userId: account.userId,
        status: await this.checkAuth(account),
      }))
    )
    const dropped = checks
      .filter((c) => c.status === 'invalid')
      .map((c) => c.userId)
    if (dropped.length) {
      for (const id of dropped) delete accounts[id]
      await this.save(accounts)
    }
    return {
      kept: checks.filter((c) => c.status === 'valid').map((c) => c.userId),
      dropped,
    }
  }

  private async checkAuth(
    account: StoredAccount
  ): Promise<'valid' | 'invalid' | 'unknown'> {
    if (!account.team?.url || !account.team?.token || !account.xoxd)
      return 'invalid'
    try {
      const url = `${account.team.url.replace(/\/?$/, '/')}api/auth.test`
      const res = await this.bridge.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // backend makes sure this _replaces_ the cookie jar
          Cookie: `d=${account.xoxd}`,
        },
        body: `token=${encodeURIComponent(account.team.token)}`,
      })
      const json = await res.json()
      return json?.ok === true ? 'valid' : 'invalid'
    } catch {
      return 'unknown'
    }
  }

  async captureCurrent(): Promise<StoredAccount | null> {
    if (!this.supported || !this.cookies) return null
    const localConfig = readLocalConfig()
    const teamId = localConfig.lastActiveTeamId
    const team = getActiveTeam(localConfig)
    if (!teamId || !team?.token || !team.user_id) return null

    const sessionCookie = await this.cookies.get({ url: SLACK_URL, name: 'd' })
    if (!sessionCookie?.value) return null

    const account: StoredAccount = {
      userId: team.user_id,
      teamId,
      team: { ...team },
      xoxd: sessionCookie.value,
      updatedAt: Date.now(),
    }
    const accounts = await this.load()
    accounts[team.user_id] = account
    await this.save(accounts)
    return account
  }

  /** works while neither account's login has revoked the other's session */
  async switchTo(userId: string): Promise<void> {
    if (!this.supported || !this.cookies)
      throw new Error('Account switching is not supported by this loader')
    const account = (await this.load())[userId]
    if (!account?.team?.token)
      throw new Error(`No usable saved account for ${userId}`)

    await this.captureCurrent()

    const cookie: TautCookie & { url: string } = {
      url: SLACK_URL,
      name: 'd',
      value: account.xoxd,
      domain: '.slack.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600,
    }
    const ok = await this.cookies.set(cookie)
    if (!ok) throw new Error('Failed to set session cookie')

    // Slack's unload flush rewrites `localConfig_v2` from redux, so the next boot writes the team entry
    localStorage.setItem('taut:pendingSwitch', JSON.stringify(account))
    location.assign(`${SLACK_URL}/client/${account.teamId}`)
  }

  /** saves the current account, removes it from this browser and reloads to Slack's login */
  async addAccount(): Promise<void> {
    if (!this.supported || !this.cookies)
      throw new Error('Account switching is not supported by this loader')

    const saved = await this.captureCurrent()
    const localConfig = readLocalConfig()
    const teamId = localConfig.lastActiveTeamId
    const domain = saved?.team.domain ?? getActiveTeam(localConfig)?.domain

    // Slack's per-session cookies, all must go for a new account to log in
    for (const name of ['d', 'd-s', 'uc']) {
      await this.cookies.remove({ url: SLACK_URL, name })
    }

    if (teamId && localConfig.teams?.[teamId]) {
      delete localConfig.teams[teamId]
      localConfig.orderedTeamIds = (localConfig.orderedTeamIds ?? []).filter(
        (id) => id !== teamId
      )
      delete localConfig.lastActiveTeamId
      localStorage.setItem('localConfig_v2', JSON.stringify(localConfig))
    }

    // TODO: improve login (desktop in-app login? automatically sign out HCA?)
    if (domain === 'hackclub') {
      const url = 'https://auth.hackclub.com'
      if (this.bridge.loader === 'electron') {
        window.open(url, '_blank')
        location.reload()
      } else {
        location.assign(url)
      }
    } else {
      location.assign(domain ? `https://${domain}.slack.com` : SLACK_URL)
    }
  }
}
