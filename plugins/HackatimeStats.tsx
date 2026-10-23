// Shows general Hackatime coding stats (total time, today, daily average, streak,
// leaderboard rank) in the user's profile in Slack.

import { TautPlugin } from '$taut'

const API_BASE = 'https://hackatime.hackclub.com/api/v1'

type LeaderboardEntry = {
  rank: number
  user: {
    id: number
    username: string
    avatar_url?: string
  }
  total_seconds: number
}

type LeaderboardResponse = {
  entries: LeaderboardEntry[]
}

type StatsTotalsData = {
  total_seconds: number
  daily_average: number
  user_id: string
  streak: number
}

type StatsTotalsResponse = {
  data: StatsTotalsData
}

type StatsTotalSecondsResponse = {
  total_seconds: number
}

type HackatimeStatsData = {
  totalSeconds: number | null
  todaySeconds: number | null
  daily_average: number | null
  user_id: number | null
  streak: number | null

  /** null = not ranked / unknown (leaderboard unavailable, whatever) */
  dailyRank: number | null
  weeklyRank: number | null

  /** of all users of the day/week */
  dailyTopPercent: number | null
  weeklyTopPercent: number | null
}

type ProfileProps = {
  member?: {
    id?: string
    display_name?: string
    real_name?: string
    name?: string
  }
}

type ProfileShellProps = {
  profileId?: string
  uiComponentName?: string
  children?: React.ReactNode
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return '0m'
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

function formatRank(rank: number): string {
  return `#${rank}`
}

/** midnight of the current local day, as an ISO string. */
function startOfTodayISO(): string {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return start.toISOString()
}

// Icons (24x24, Stroke-Style) (from AI)

type IconProps = { size?: number }

const Icon = ({
  size = 14,
  children,
}: IconProps & { children: React.ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flexShrink: 0, color: 'var(--sk_foreground_low, #616061)' }}
  >
    {children}
  </svg>
)

const CodeIcon = (p: IconProps) => (
  <Icon {...p}>
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </Icon>
)

const ClockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </Icon>
)

const SunIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
    <path d="m4.93 4.93 1.41 1.41M17.66 17.66l1.41 1.41M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </Icon>
)

const AverageIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
    <path d="m19 9-5 5-4-4-3 3" />
  </Icon>
)

const StreakIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  </Icon>
)

const TrophyIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
    <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
    <path d="M4 22h16" />
    <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
    <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
    <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
  </Icon>
)

function formatTopPercent(percent: number): string {
  return `Top ${percent}%`
}

export default class HackatimeStats extends TautPlugin<typeof HackatimeStats> {
  static readonly id = 'HackatimeStats'
  static readonly pluginName = 'Hackatime Stats'
  static readonly description =
    'Shows general Hackatime coding stats (total time, today, daily average, streak, leaderboard rank) in the profile pane'
  static readonly authors = ['fantamomo'] as const
  static readonly category = 'people'
  static readonly hackClubOnly = true
  static readonly defaultConfig = {
    enabled: false,
  }

  // coding time changes throughout the day, so keep this shorter-lived
  private statsCache = new this.api.Cache<HackatimeStatsData | null>(
    'hackatime_general_stats',
    {
      ttl: 10 * 60 * 1000, // 10 minutes
      maxSize: 5000,
    }
  )

  // shared across all users, only two possible keys ('daily' / 'weekly').
  private leaderboardCache = new this.api.Cache<LeaderboardEntry[] | null>(
    'hackatime_leaderboard',
    {
      ttl: 10 * 60 * 1000, // 10 minutes
      maxSize: 2,
    }
  )

  private isEligible(userId: string | undefined): userId is string {
    return (
      !!userId &&
      (userId.startsWith('U') || userId.startsWith('W')) &&
      userId !== 'USLACKBOT'
    )
  }

  private useStats(userId: string | undefined): HackatimeStatsData | null {
    const eligible = this.isEligible(userId)
    const [stats, setStats] = React.useState<HackatimeStatsData | null>(() =>
      eligible ? (this.statsCache.get(userId!) ?? null) : null
    )

    React.useEffect(() => {
      if (!eligible) return
      this.fetchStats(userId!)
        .then(setStats)
        .catch(() => {})
    }, [userId, eligible])

    return stats
  }

  private StatRow = (props: {
    icon: React.ReactNode
    label: string
    value: React.ReactNode
  }) => (
    <div className="taut-hackatime-stats__row">
      {props.icon}
      <span>
        {props.label}: <strong>{props.value}</strong>
      </span>
    </div>
  )

  private StatsBlock = (props: {
    userId?: string
    member?: ProfileProps['member']
  }) => {
    const stats = this.useStats(props.userId)

    if (!stats) return null
    if (stats.totalSeconds === null && stats.todaySeconds === null) return null

    const rankText = (rank: number, topPercent: number | null) =>
      topPercent !== null
        ? `${formatRank(rank)} (${formatTopPercent(topPercent)})`
        : formatRank(rank)

    return (
      <div className="p-r_member_profile_section taut-hackatime-stats">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '10px 0',
            width: '100%',
            borderTop: '1px solid rgba(29, 28, 29, 0.13)',
            fontWeight: 700,
          }}
        >
          <CodeIcon />
          Hackatime
        </div>

        {stats.todaySeconds !== null && (
          <this.StatRow
            icon={<SunIcon />}
            label="Today"
            value={formatDuration(stats.todaySeconds)}
          />
        )}

        {stats.totalSeconds !== null && (
          <this.StatRow
            icon={<ClockIcon />}
            label="Total"
            value={formatDuration(stats.totalSeconds)}
          />
        )}

        {stats.daily_average !== null && (
          <this.StatRow
            icon={<AverageIcon />}
            label="Daily average"
            value={formatDuration(stats.daily_average)}
          />
        )}

        {stats.streak !== null && (
          <this.StatRow
            icon={<StreakIcon />}
            label="Streak"
            value={`${stats.streak} ${stats.streak === 1 ? 'day' : 'days'}`}
          />
        )}

        {stats.dailyRank !== null && (
          <this.StatRow
            icon={<TrophyIcon />}
            label="Daily leaderboard"
            value={rankText(stats.dailyRank, stats.dailyTopPercent)}
          />
        )}

        {stats.weeklyRank !== null && (
          <this.StatRow
            icon={<TrophyIcon />}
            label="Weekly leaderboard"
            value={rankText(stats.weeklyRank, stats.weeklyTopPercent)}
          />
        )}
      </div>
    )
  }

  async start() {
    this.log('Starting')

    await this.statsCache.load()
    if (this.api.signal.aborted) return
    await this.leaderboardCache.load()
    if (this.api.signal.aborted) return

    // patch the full profile pane to add a stats block below the existing
    // presence info.
    // patching the Content component to add the StatsBlock on the user profile
    this.api.patchComponent<{ children?: unknown }>(
      'Content',
      (Original) => (props) => {
        const children = props.children
        if (!React.isValidElement<ProfileShellProps>(children))
          return <Original {...props} />
        const existing = children.props.children
        if (!Array.isArray(existing)) return <Original {...props} />

        // This is the profile's scrollable body, after bio, recent DMs, and custom fields.
        // Match the known shell directly; no recursive profile scan.
        const userId = children.props.profileId
        if (
          children.props.uiComponentName !== 'rimeto_member_profile_flexpane' ||
          !userId ||
          !/^[UW][A-Z0-9]+$/.test(userId)
        )
          return <Original {...props} />

        const sections = existing.map((child) => {
          if (
            !React.isValidElement<{
              'data-qa'?: string
              children?: React.ReactNode
            }>(child) ||
            child.props['data-qa'] !== 'member_profile_pane'
          )
            return child
          return React.cloneElement(
            child,
            undefined,
            child.props.children,
            <this.StatsBlock key="taut-stats" userId={userId} />
          )
        })

        return (
          <Original
            {...props}
            children={React.cloneElement(children, undefined, ...sections)}
          />
        )
      }
    )

    this.injectStyles()
    this.log('Loaded successfully!')
  }

  stop(): void {
    this.log('Stopped')
  }

  private async request<R = object>(path: string): Promise<R | null> {
    if (!path.startsWith('/')) path = `/${path}`
    const res = await this.api.fetch(`${API_BASE}${path}`, {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
      signal: this.api.signal,
    })

    if (res.status === 403 || res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`)

    return res.json()
  }

  private async fetchTotalStats(
    slackId: string
  ): Promise<StatsTotalsData | null> {
    const res = await this.request<StatsTotalsResponse>(
      `/users/${slackId}/stats?features=,`
    )

    if (!res) return null

    return res.data ?? null
  }

  private async fetchTodaySeconds(slackId: string): Promise<number | null> {
    const params = new URLSearchParams({
      total_seconds: 'true',
      start_date: startOfTodayISO(),
    })

    const res = await this.request<StatsTotalSecondsResponse>(
      `/users/${slackId}/stats?${params.toString()}`
    )

    if (!res) return null

    return res.total_seconds ?? null
  }

  private async fetchLeaderboard(
    period: 'daily' | 'weekly'
  ): Promise<LeaderboardEntry[] | null> {
    return this.leaderboardCache.fetch(period, async () => {
      const res = await this.api.fetch(`${API_BASE}/leaderboard/${period}`, {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
        signal: this.api.signal,
      })

      // 503: leaderboard is still being generated
      if (res.status === 503) return null
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`)

      const data = (await res.json()) as LeaderboardResponse
      return data.entries ?? []
    })
  }

  private async findRanks(user_id: number): Promise<{
    dailyRank: number | null
    dailyTopPercent: number | null
    weeklyRank: number | null
    weeklyTopPercent: number | null
  }> {
    const calc = (entries: LeaderboardEntry[] | null) => {
      if (!entries || entries.length === 0)
        return { rank: null, topPercent: null }
      const match = entries.find((entry) => entry.user.id === user_id)
      if (!match) return { rank: null, topPercent: null }

      const topPercent = Math.max(
        1,
        Math.ceil((match.rank / entries.length) * 100)
      )
      return { rank: match.rank, topPercent }
    }

    const [daily, weekly] = await Promise.all([
      this.fetchLeaderboard('daily').catch(() => null),
      this.fetchLeaderboard('weekly').catch(() => null),
    ])

    const d = calc(daily)
    const w = calc(weekly)

    return {
      dailyRank: d.rank,
      dailyTopPercent: d.topPercent,
      weeklyRank: w.rank,
      weeklyTopPercent: w.topPercent,
    }
  }

  async fetchStats(slackId: string): Promise<HackatimeStatsData | null> {
    return this.statsCache.fetch(slackId, async () => {
      const [data, todaySeconds] = await Promise.all([
        this.fetchTotalStats(slackId).catch(() => null),
        this.fetchTodaySeconds(slackId).catch(() => null),
      ])

      const defaultRank = {
        dailyRank: null,
        dailyTopPercent: null,
        weeklyRank: null,
        weeklyTopPercent: null,
      }

      const user_id = data?.user_id ? Number(data.user_id) : null

      const ranks = user_id
        ? await this.findRanks(user_id).catch(() => defaultRank)
        : defaultRank

      const totalSeconds = data?.total_seconds ?? null

      // Both public-facing numbers are missing:
      //   most likely the user has public stats lookup disabled (403) or doesn't exist (404).
      //   Don't show any rank in that case either.
      if (totalSeconds === null && todaySeconds === null) return null

      return {
        totalSeconds,
        todaySeconds,
        daily_average: data?.daily_average ?? null,
        user_id: user_id ?? null,
        streak: data?.streak ?? null,
        dailyRank: ranks.dailyRank,
        weeklyRank: ranks.weeklyRank,
        dailyTopPercent: ranks.dailyTopPercent,
        weeklyTopPercent: ranks.weeklyTopPercent,
      }
    })
  }

  private injectStyles() {
    this.api.setStyle(`
    .taut-hackatime-stats {
      display: block;
      width: 100%;
      box-sizing: border-box;
      padding: 16px;
      text-align: left;
      align-self: stretch;
    }

    .taut-hackatime-stats__row {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
      width: 100%;
      text-align: left;
      font-size: 13px;
    }

    .taut-hackatime-stats__row svg {
      flex-shrink: 0;
    }
  `)
  }
}
