// Taut Account Switcher
// Switches between multiple Slack accounts in the same workspace without going
// through Slack's login flow

// tw: ai blurb:
// - A Slack web session is authenticated by an `xoxc` token (POST body of
//   every API call, stored in localStorage `localConfig_v2`) PLUS the `d`
//   (xoxd) cookie. The server binds the two: a token is rejected unless the
//   matching cookie is present. The cookie is HttpOnly, so only the loader
//   (via `bridge.cookies`) can write it.
// - Two same-workspace sessions coexist server-side as long as neither login
//   revoked the other. So we capture each account's localConfig team entry +
//   `d` cookie when it is live, and to switch we re-apply a stored pair: set
//   the `d` cookie and write the team entry back into `localConfig_v2`.
// - We store the WHOLE localConfig team object, not a subset: enterprise/grid
//   boot needs fields like `url` (the API host) to route requests, dropping
//   them yields `api_missing_host_error`.
// - Writing `localConfig_v2` from the live page is futile: Slack's unload
//   flush rewrites it from its in-memory Redux state on navigation. So the
//   switch stashes the desired account in a localStorage handoff key and
//   reloads; `applyPendingSwitch()` re-applies it synchronously at the very
//   start of the next boot, before Slack reads `localConfig_v2`. The cookie,
//   unlike localStorage, persists across the reload and needs no re-apply.

import type { TautBridge, TautCookie } from '../../shared/TautBridge'
import {
  getActiveTeam,
  type LocalConfigTeam,
  readLocalConfig,
} from './localConfig'

const SLACK_URL = 'https://app.slack.com'
const COOKIE_DOMAIN = '.slack.com'
const SECRET_KEY = 'accounts' // bridge secret: Record<userId, StoredAccount>
const PENDING_SWITCH_KEY = 'taut:pendingSwitch' // localStorage handoff key

// Slack's per-session cookies, all must be cleared for a new account to be logged in
const SESSION_COOKIES = ['d', 'd-s', 'uc']

export type StoredAccount = {
  userId: string
  teamId: string
  team: LocalConfigTeam
  xoxd: string
  updatedAt: number
}

/**
 * Must be called at the very top of bootstrap(), before any await and before
 * Slack's webpack runs, so the token is in place when Slack boots
 * Slack saves the token to localStorage in the unload handler, so we have to
 * set it now
 */
export function applyPendingSwitch(): void {
  let pendingJson: string | null
  try {
    pendingJson = localStorage.getItem(PENDING_SWITCH_KEY)
  } catch {
    return
  }
  if (!pendingJson) return
  localStorage.removeItem(PENDING_SWITCH_KEY)

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
  /** Whether this loader can switch accounts at all (needs cookie access). */
  readonly supported: boolean
  private readonly cookies: TautBridge['cookies']

  constructor(private bridge: TautBridge) {
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

  /** All saved accounts. */
  async list(): Promise<StoredAccount[]> {
    return Object.values(await this.load())
  }

  /** Remove a saved account from the store (does not touch the live session). */
  async forget(userId: string): Promise<void> {
    const accounts = await this.load()
    delete accounts[userId]
    await this.save(accounts)
  }

  /**
   * Validate every saved account against the server and drop any that no longer
   * authenticate
   */
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

  /** auth.test a stored pair via a custom Cookie header */
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

  /** Capture the currently-active account into the store */
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

  /**
   * Switch to a previously-saved account: set its `d` cookie now, stash the
   * account for `applyPendingSwitch()` (handles the team entry), then reload
   */
  async switchTo(userId: string): Promise<void> {
    if (!this.supported || !this.cookies)
      throw new Error('Account switching is not supported by this loader')
    const account = (await this.load())[userId]
    if (!account?.team?.token)
      throw new Error(`No usable saved account for ${userId}`)

    // Keep the account we're leaving fresh before we go.
    await this.captureCurrent()

    const cookie: TautCookie & { url: string } = {
      url: SLACK_URL,
      name: 'd',
      value: account.xoxd,
      domain: COOKIE_DOMAIN,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600,
    }
    const ok = await this.cookies.set(cookie)
    if (!ok) throw new Error('Failed to set session cookie')

    localStorage.setItem(PENDING_SWITCH_KEY, JSON.stringify(account))
    location.assign(`${SLACK_URL}/client/${account.teamId}`)
  }

  /**
   * Add a new account: save the current one, wipe it, reload to login
   */
  async addAccount(): Promise<void> {
    if (!this.supported || !this.cookies)
      throw new Error('Account switching is not supported by this loader')

    const saved = await this.captureCurrent()
    const localConfig = readLocalConfig()
    const teamId = localConfig.lastActiveTeamId
    const domain = saved?.team.domain ?? getActiveTeam(localConfig)?.domain

    // kill all session cookies
    for (const name of SESSION_COOKIES) {
      await this.cookies.remove({ url: SLACK_URL, name })
    }

    // drop the localConfig team
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
