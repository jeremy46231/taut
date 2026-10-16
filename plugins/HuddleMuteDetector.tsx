import { TautPlugin } from '$taut'

/**
 * HuddleMuteDetector
 *
 * Slack mutes you in a huddle when a peer sends a mute request on the Chime data channel.
 * The client then dispatches displayAlertMessage({ alert: 'peerMuteRequest', peerId: <SENDER attendeeId> }).
 * The sender's attendeeId maps to a Slack user via state.peers.byId[attendeeId].userId.
 */
export default class HuddleMuteDetector extends TautPlugin<
  typeof HuddleMuteDetector
> {
  static readonly id = 'HuddleMuteDetector'
  static readonly pluginName = 'Huddle Mute Detector'
  static readonly description = 'Who muted me? Now you can see!'
  static readonly authors = '<@U09KKMHLS15>'
  static readonly defaultConfig = {
    enabled: false,
  }

  start(): void {
    this.api.redux.patchThunk(
      'displayAlertMessage',
      (original) => (payload: any) => {
        if (payload?.alert === 'peerMuteRequest')
          this.onPeerMute(payload.peerId)
        return original(payload)
      }
    )
  }

  private onPeerMute(attendeeId?: string): void {
    const state = this.api.redux.getRawState()
    // The huddle window has its own store; the main window gets the same alert without peer data.
    if (!state?.peers?.byId || Object.keys(state.peers.byId).length === 0)
      return
    const userId: string | undefined = attendeeId
      ? state.peers.byId[attendeeId]?.userId
      : undefined
    if (!userId) return
    const member = state.members?.[userId]
    const name: string =
      member?.profile?.display_name ||
      member?.profile?.real_name ||
      member?.name ||
      userId

    this.api.redux
      .dispatchThunk('enqueueHuddleToast', {
        content: `${name} muted you.`,
        huddleToastType: 'peer_mute_request',
      })
      .catch(() => undefined)
  }
}
