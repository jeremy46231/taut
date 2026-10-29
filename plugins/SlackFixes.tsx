// Fixes small bugs in Slack's UI

import { TautPlugin } from '$taut'

export default class SlackFixes extends TautPlugin<typeof SlackFixes> {
  static readonly id = 'SlackFixes'
  static readonly pluginName = 'Slack Fixes'
  static readonly description = "Fixes small bugs in Slack's UI"
  static readonly authors = ['jeremy'] as const
  static readonly category = 'app'
  static readonly defaultConfig = {
    enabled: true,
  }

  start(): void {
    /* halloween sidebar row */
    this.api.setStyle(`
      [data-qa="spooky_sidebar_candy_icon"] {
        width: 16px;
        padding-right: 0;
        justify-content: center;
      }
      [class*="spookySidebarLinkContainer__"] { border-radius: 6px; }
    `)

    this.patchThreadModeration()
    this.log('Started')
  }

  // slack hides thread moderation when it can't tell the root's team, but it has bad logic for that
  private patchThreadModeration() {
    const StateView = this.api.redux.StateView
    this.api.patchComponent<{ channelId: string; threadTs: string }>(
      'ThreadFlexpaneAdminTools',
      (Original) => (props) => {
        const { channelId, threadTs } = props
        const patch = React.useCallback(
          (state: any) => this.withRootTeam(state, channelId, threadTs),
          [channelId, threadTs]
        )
        return (
          <StateView patch={patch}>
            <Original {...props} />
          </StateView>
        )
      }
    )
  }

  /** `state` with the thread root's `source_team_id` filled in from its bot */
  private withRootTeam(state: any, channelId: string, threadTs: string) {
    const root = state?.messages?.[channelId]?.[threadTs]
    if (!root || root.source_team_id) return state
    const team = root.bot_profile?.team_id ?? state.bots?.[root.bot_id]?.team_id
    if (!team) return state
    const fixed = { ...root, source_team_id: team }
    const { mapEntries } = this.api.redux
    return {
      ...state,
      messages: mapEntries(state.messages, (id, bucket) =>
        id === channelId && bucket
          ? mapEntries(bucket, (ts, msg) => (ts === threadTs ? fixed : msg))
          : bucket
      ),
    }
  }
}
