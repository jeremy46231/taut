// writes go through the web api, and Slack's store picks them up over the socket

import { userAPI } from '../api/userAPI'
import type { Block } from './blocks'
import { getCachedMember, getCurrentMemberId } from './members'
import { getRawState } from './redux'

export type SlackStatus = {
  text: string
  emoji: string
  /** when Slack clears it, ms since the epoch, or 0 for never */
  expiration: number
  /** the Slack preset it's from, like "Out of office", or "" */
  canonical: string
}

const self = () => {
  const id = getCurrentMemberId()
  return id ? getCachedMember(id) : undefined
}

/** your status, or undefined before Slack has loaded you */
export function getStatus(): SlackStatus | undefined {
  const profile = self()?.profile
  if (!profile) return undefined
  return {
    text: String(profile.status_text ?? ''),
    emoji: String(profile.status_emoji ?? ''),
    expiration: Number(profile.status_expiration ?? 0) * 1000,
    canonical: String(profile.status_text_canonical ?? ''),
  }
}

/** `oooMessage` is the out of office reply as rich text blocks (see `elements.RichTextInput`), [] removes it */
export async function setStatus(
  status: Partial<SlackStatus> & { oooMessage?: Block[] }
): Promise<void> {
  const { text = '', emoji = '', expiration = 0, canonical = '' } = status
  const profile: Record<string, string | number> = {
    status_text: text,
    status_emoji: emoji,
    status_expiration: Math.ceil(expiration / 1000),
    status_text_canonical: canonical,
  }
  if (status.oooMessage !== undefined) {
    profile.ooo_message = status.oooMessage.length
      ? JSON.stringify(status.oooMessage)
      : ''
  }
  await userAPI(
    'users.profile.set',
    { profile: JSON.stringify(profile) },
    { rateLimitRetries: 2 }
  )
}

/** "away" if you set yourself away, else "auto", undefined before Slack loads you */
export function getPresence(): 'auto' | 'away' | undefined {
  const manual = self()?.manual_presence
  if (manual === undefined) return undefined
  return manual === 'away' ? 'away' : 'auto'
}

export async function setPresence(presence: 'auto' | 'away'): Promise<void> {
  await userAPI('users.setPresence', { presence }, { rateLimitRetries: 2 })
}

/** when your paused notifications resume, in ms, or null if not paused */
export function getSnooze(): number | null {
  const snooze = getRawState()?.dndV2?.currentMemberSnooze
  return snooze?.snoozeEnabled && snooze.snoozeEndTs
    ? snooze.snoozeEndTs * 1000
    : null
}

/** pause notifications until a time (to the minute), or null to resume them */
export async function setSnooze(until: number | null): Promise<void> {
  if (until === null) {
    await userAPI('dnd.endSnooze', {}, { rateLimitRetries: 2 })
    return
  }
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000))
  await userAPI(
    'dnd.setSnooze',
    { num_minutes: String(minutes) },
    { rateLimitRetries: 2 }
  )
}

/** your Slack time zone, like "America/New_York" */
export function getTimeZone(): string | undefined {
  const tz = self()?.tz
  return typeof tz === 'string' && tz ? tz : undefined
}

export const profile = {
  getStatus,
  setStatus,
  getPresence,
  setPresence,
  getSnooze,
  setSnooze,
  getTimeZone,
}
