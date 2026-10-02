import { retry } from '../helpers'
import { reactPromise } from './react'
import {
  dispatchThunk,
  getRawState,
  getReduxStore,
  reduxPromise,
} from './redux'
import { waitForExport } from './webpack'

export type SlackMember = {
  id?: string
  name?: string
  real_name?: string
  deleted?: boolean
  isUnknown?: boolean
  isNonExistent?: boolean
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

type GetMemberById = (state: any, userId: string) => SlackMember | undefined

// mirrors Slack's name logic (`computeDerivedNames`)
const deburr = (s: string): string =>
  s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
const lc = (s: string): string => String(s).toLowerCase()

/** returns a copy, with the derived `_lc` and normalized names updated too */
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

/** hides Slack's unloaded-member placeholders, which have empty names and all share one `profile` */
const loaded = (member?: SlackMember): SlackMember | undefined =>
  !member || member.isUnknown === true || member.isNonExistent === true
    ? undefined
    : member

export function getCachedMember(userId: string): SlackMember | undefined {
  return loaded(getReduxStore()?.getState().members?.[userId])
}

/** the member this client is signed in as */
export function getCurrentMemberId(): string | undefined {
  return getRawState()?.bootData?.user_id
}

const inFlight = new Map<string, Promise<SlackMember | undefined>>()

let batch: { ids: Set<string>; done: Promise<void> } | undefined

function fetchMembers(userId: string): Promise<void> {
  if (!batch) {
    const ids = new Set<string>()
    const done = new Promise<void>((resolve) => setTimeout(resolve, 5)).then(
      async () => {
        batch = undefined
        try {
          await dispatchThunk('ensureMembersArePresent', {
            memberIds: [...ids],
            reason: 'taut',
          })
        } catch {}
      }
    )
    batch = { ids, done }
  }
  batch.ids.add(userId)
  return batch.done
}

/** asks Slack to fetch the member if the store doesn't have them yet */
export async function getMember(
  userId: string
): Promise<SlackMember | undefined> {
  const cached = getCachedMember(userId)
  if (cached) return cached

  const pending = inFlight.get(userId)
  if (pending) return pending

  const request = retry(
    async () => {
      await fetchMembers(userId)
      return getCachedMember(userId)
    },
    { tries: 4, baseMs: 3000 }
  ).finally(() => inFlight.delete(userId))
  inFlight.set(userId, request)
  return request
}

export const membersPromise = (async () => {
  const React = await reactPromise
  const { useReduxState } = await reduxPromise
  let selector: GetMemberById | undefined
  waitForExport<GetMemberById>(
    (e: any) =>
      typeof e === 'function' && e.meta?.key === 'createSelectorGetMemberById'
  ).then((found) => {
    selector = found
  })
  const readMember: GetMemberById = (state, userId) =>
    selector?.(state, userId) ?? state.members?.[userId]

  /** reactively read a member, asking Slack to load them if it hasn't yet */
  function useMember(userId: string): SlackMember | undefined {
    const member = useReduxState<SlackMember | undefined>((s) =>
      loaded(readMember(s, userId))
    )
    const missing = !member
    React.useEffect(() => {
      if (userId && missing) getMember(userId)
    }, [userId, missing])
    return member
  }

  return {
    getCachedMember,
    getCurrentMemberId,
    getMember,
    useMember,
    modifyMemberObject,
  }
})()

export type MembersAPI = Awaited<typeof membersPromise>
