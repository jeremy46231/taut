// Reads Slack channels from the redux store, and builds channel objects from a
// set of known fields

import { getReduxStore } from './redux'

export type SlackChannel = {
  id?: string
  name?: string
  name_normalized?: string
  _name_lc?: string
  is_channel?: boolean
  is_group?: boolean
  is_im?: boolean
  is_mpim?: boolean
  is_private?: boolean
  is_member?: boolean
  is_archived?: boolean
  is_general?: boolean
  previous_names?: string[]
  isNonExistent?: boolean
  isUnknown?: boolean
  [key: string]: unknown
}

// Mirror Slack's name logic
const deburr = (s: string): string =>
  s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
const lc = (s: string): string => String(s).toLowerCase()

export function makeChannelObject(channel: {
  id: string
  name: string
  /** defaults to false */
  isPrivate?: boolean
  /** defaults to false */
  isMember?: boolean
  isArchived?: boolean
  /** former names, also used in autocomplete */
  previousNames?: string[]
}): SlackChannel {
  const {
    id,
    name,
    isPrivate = false,
    isMember = false,
    isArchived = false,
    previousNames = [],
  } = channel
  return {
    id,
    name,
    name_normalized: deburr(name),
    _name_lc: deburr(lc(name)),
    is_channel: !isPrivate,
    is_group: isPrivate,
    is_im: false,
    is_mpim: false,
    is_private: isPrivate,
    is_member: isMember,
    is_archived: isArchived,
    is_general: false,
    previous_names: previousNames,
    isNonExistent: false,
    isUnknown: false,
  }
}

export function getCachedChannel(channelId: string): SlackChannel | undefined {
  return getReduxStore()?.getState().channels?.[channelId]
}

export const channelsPromise = (async () => {
  return { getCachedChannel, makeChannelObject }
})()

export type ChannelsAPI = Awaited<typeof channelsPromise>
