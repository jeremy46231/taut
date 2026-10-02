// Leaves apps, and optionally guests, out of the channel header's member count

import { opt, TautPlugin } from '$taut'

type AvatarStackProps = { channelId?: string; memberCount?: number }
type MembershipCounts = {
  member_count?: number
  restricted_member_count?: number | null
}

export default class HumanCount extends TautPlugin<typeof HumanCount> {
  static readonly id = 'HumanCount'
  static readonly pluginName = 'Human Count'
  static readonly description =
    "Leaves apps, and optionally guests, out of the channel header's member count"
  static readonly authors = ['jeremy', 'rowan'] as const
  static readonly category = 'people'
  static readonly defaultConfig = {
    enabled: false,
    excludeGuests: opt(false, 'Also leave out guests'),
  }

  start(): void {
    this.api.patchComponent<AvatarStackProps>(
      'BaseAvatarStack',
      (Original) => (props) => {
        const { channelId } = props
        const count = this.api.redux.useReduxState((state) => {
          if (!channelId) return undefined
          const channel = state.channels?.[channelId]
          if (!channel || channel.is_im || channel.is_mpim) return undefined
          const counts: MembershipCounts | undefined =
            state.membershipCounts?.[channelId]?.counts
          const people = counts?.member_count
          if (typeof people !== 'number') return undefined
          const guests = this.config.excludeGuests
            ? Number(counts?.restricted_member_count) || 0
            : 0
          return Math.max(0, people - guests)
        })
        if (typeof props.memberCount !== 'number' || count === undefined)
          return <Original {...props} />
        return <Original {...props} memberCount={count} />
      }
    )
  }
}
