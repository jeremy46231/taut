// Reads Slack member profiles from the redux store

import { userAPI } from '../api/userAPI'
import { reactPromise } from './react'
import { getReduxStore, reduxPromise } from './redux'
import { findExportPromise } from './webpack'

export type SlackMember = {
  id?: string
  name?: string
  real_name?: string
  deleted?: boolean
  profile?: {
    display_name?: string
    real_name?: string
    image_24?: string
    image_48?: string
    image_72?: string
    image_192?: string
    image_512?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

type HydrateHook = (opts: {
  reason: string
  memberId: string
  skip?: boolean
}) => void

// Mirror Slack's name logic (module CD4g `computeDerivedNames`)
const deburr = (s: string): string =>
  s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
const lc = (s: string): string => String(s).toLowerCase()

/**
 * return a copy of the `member` object with the given fields
 * replaced
 */
export function modifyMemberObject(
  member: SlackMember,
  edits: {
    /** both display name and real name */
    name?: string
    /** defaults to `name` */
    displayName?: string
    /** defaults to `name` */
    realName?: string
  }
): SlackMember {
  const profile = { ...member.profile }
  const next: SlackMember = { ...member, profile }

  const { name, displayName = name, realName = name } = edits
  if (displayName !== undefined) {
    profile.display_name = displayName
    profile.display_name_normalized = deburr(displayName)
    next._display_name_lc = lc(displayName)
    next._display_name_normalized_lc = deburr(lc(displayName))
  }
  if (realName !== undefined) {
    next.real_name = realName
    profile.real_name = realName
    profile.real_name_normalized = deburr(realName)
    next._real_name_lc = lc(realName)
    next._real_name_normalized_lc = deburr(lc(realName))
  }

  return next
}

export function getCachedMember(userId: string): SlackMember | undefined {
  return getReduxStore()?.getState().members?.[userId]
}

function isLoaded(member?: SlackMember): boolean {
  return !!(
    member?.profile?.display_name ||
    member?.profile?.real_name ||
    member?.real_name
  )
}

type UpsertMembers = (arg: { members: SlackMember[] }) => unknown
let upsertMembersThunk: UpsertMembers | null | undefined

async function storeMember(member: SlackMember): Promise<void> {
  const store = getReduxStore()
  if (!store) return
  if (upsertMembersThunk === undefined) {
    const findExport = await findExportPromise
    upsertMembersThunk =
      findExport(
        (e: any) => typeof e === 'function' && e.meta?.name === 'upsertMembers'
      ) ?? null
  }
  if (!upsertMembersThunk) return
  try {
    store.dispatch(upsertMembersThunk({ members: [member] }))
  } catch {}
}

/** Get a member, fetching it if redux doesn't have it yet */
export async function getMember(
  userId: string
): Promise<SlackMember | undefined> {
  const cached = getCachedMember(userId)
  if (isLoaded(cached)) return cached
  try {
    const { user } = await userAPI('users.info', { user: userId })
    const member = user as SlackMember
    await storeMember(member)
    return member
  } catch {
    return cached
  }
}

export const membersPromise = (async () => {
  await reactPromise
  const { useReduxState } = await reduxPromise
  const findExport = await findExportPromise
  // Resolved up front so useMember's hook set is stable across renders
  const useHydrateMember: HydrateHook =
    findExport(
      (e: any) =>
        typeof e === 'function' && e.name === 'useHydrateMemberProfileFields'
    ) ?? (() => {})

  /** Reactively read a member, asking Slack to load it if not present yet. */
  function useMember(userId: string): SlackMember | undefined {
    const member = useReduxState<SlackMember | undefined>(
      (s) => s.members?.[userId]
    )
    useHydrateMember({
      reason: 'taut',
      memberId: userId,
      skip: isLoaded(member),
    })
    return member
  }

  return { getCachedMember, getMember, useMember, modifyMemberObject }
})()

export type MembersAPI = Awaited<typeof membersPromise>
