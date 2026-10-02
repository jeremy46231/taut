import { readLocalConfig } from './localConfig'
import { getRawState, subscribeStore } from './redux'

/** the Hack Club enterprise grid and the workspace inside it */
const HACK_CLUB_IDS = new Set(['E09V59WQY1E', 'T0266FRGM'])

type SelfTeamIds = {
  teamId?: string
  enterpriseId?: string
  internalWorkspaceIds?: string[]
}

const selfTeamIds = (): SelfTeamIds | undefined => getRawState()?.selfTeamIds

/** the team in `/client/<id>/...`, which is the one this page booted into */
const urlTeamId = (): string | undefined =>
  /^\/client\/([TE][A-Z0-9]+)/.exec(location.pathname)?.[1]

let cachedFor: SelfTeamIds | undefined
let cachedResult = false

/** cached against Slack's state until the workspace changes, so it's cheap on every render */
function isHackClub(): boolean {
  const self = selfTeamIds()
  if (self && self === cachedFor) return cachedResult
  let ids: unknown[]
  if (self) {
    ids = [self.teamId, self.enterpriseId, ...(self.internalWorkspaceIds ?? [])]
  } else {
    // before Slack's store exists, localConfig knows which grid a team is in
    const config = readLocalConfig()
    const id = urlTeamId() ?? config.lastActiveTeamId
    ids = [id, id ? config.teams?.[id]?.enterprise_id : undefined]
  }
  const result = ids.some(
    (id) => typeof id === 'string' && HACK_CLUB_IDS.has(id)
  )
  if (self) {
    cachedFor = self
    cachedResult = result
  }
  return result
}

/** calls `listener` whenever `isHackClub()` changes, returns a disposer */
function onChange(listener: () => void): () => void {
  let last = workspace.isHackClub()
  return subscribeStore(() => {
    const next = workspace.isHackClub()
    if (next === last) return
    last = next
    listener()
  })
}

/** `isHackClub()` as a hook */
function useIsHackClub(): boolean {
  return React.useSyncExternalStore(workspace.onChange, workspace.isHackClub)
}

/** callers go through this object, so overriding `isHackClub` here (from the console) applies everywhere */
export const workspace = { isHackClub, onChange, useIsHackClub }
