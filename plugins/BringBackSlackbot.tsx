// Shows Slackbot's custom responses as sent by Slackbot again

import { type SlackMessage, TautPlugin } from '$taut'

type LabelsProps = {
  msg?: SlackMessage
  setBackground?: (background: { labels?: string }) => void
  children?: React.ReactNode
}
type LabelsTextProps = {
  isCustomResponse?: boolean
  isPinned?: boolean
  isLater?: boolean
  isEphemeral?: boolean
  isDLPUserWarningError?: boolean
}

export default class BringBackSlackbot extends TautPlugin<
  typeof BringBackSlackbot
> {
  static readonly id = 'BringBackSlackbot'
  static readonly pluginName = 'Bring Back Slackbot'
  static readonly description =
    "Shows Slackbot's custom responses as sent by Slackbot again"
  static readonly authors = ['jeremy'] as const
  static readonly category = 'messages'
  static readonly hackClubOnly = true
  static readonly defaultConfig = {
    enabled: true,
  }

  start(): void {
    const withoutSubtype = (_ts: string, msg: SlackMessage | undefined) => {
      if (!isCustomResponse(msg)) return msg
      const plain = { ...msg }
      delete plain.subtype
      return plain
    }
    this.api.redux.patchSlice<object>('messages', (_channel, bucket) =>
      bucket && typeof bucket === 'object'
        ? this.api.redux.mapEntries(bucket, withoutSubtype)
        : bucket
    )

    this.api.patchComponent<LabelsProps>(
      'MessageLabels',
      (Original) => (props) => {
        const { msg, setBackground, children } = props
        const custom = isCustomResponse(this.api.messages.asRawMessage(msg))
        const labelled = React.useMemo(
          () => (custom ? { ...msg, subtype: 'slackbot_response' } : msg),
          [custom, msg]
        )
        const [primary, setPrimary] = React.useState<string>()
        const report = React.useCallback(
          (background: { labels?: string }) => {
            setPrimary(background?.labels)
            setBackground?.(background)
          },
          [setBackground]
        )
        if (!custom) return <Original {...props} />
        return (
          <Original
            {...props}
            msg={labelled}
            setBackground={setBackground && report}
          >
            {primary === 'custom_response' && (
              <div className="c-message_kit__labels__label c-message_kit__labels--custom_response">
                <div className="c-message_kit__labels__icon">
                  <this.api.elements.Icon type="pencil" size="inherit" />
                </div>
                <span className="c-message_kit__labels__text">
                  Custom response
                </span>
              </div>
            )}
            {children}
          </Original>
        )
      }
    )

    // combine label with pinned label
    this.api.patchComponent<LabelsTextProps>(
      'LabelsText',
      (Original) => (props) => {
        const both =
          props.isCustomResponse &&
          props.isPinned &&
          !props.isLater &&
          !props.isEphemeral &&
          !props.isDLPUserWarningError
        if (!both) return <Original {...props} />
        return (
          <>
            <Original {...props} /> ∙ Custom response
          </>
        )
      }
    )
  }
}

const isCustomResponse = (msg: SlackMessage | undefined): msg is SlackMessage =>
  msg?.subtype === 'slackbot_response' && msg.user === 'USLACKBOT'
