export type LocalConfigTeam = {
  id?: string
  name?: string
  domain?: string
  user_id?: string
  token?: string
  url?: string
  [key: string]: unknown
}

export type LocalConfig = {
  teams?: Record<string, LocalConfigTeam>
  lastActiveTeamId?: string
  orderedTeamIds?: string[]
  [key: string]: unknown
}

export function readLocalConfig(): LocalConfig {
  try {
    return JSON.parse(localStorage.getItem('localConfig_v2') || '{}')
  } catch {
    return {}
  }
}

/** the localConfig team entry for the active workspace */
export function getActiveTeam(
  config: LocalConfig = readLocalConfig()
): LocalConfigTeam | undefined {
  const teamId = config.lastActiveTeamId
  return teamId ? config.teams?.[teamId] : undefined
}
