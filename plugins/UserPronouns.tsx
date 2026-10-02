// Shows people's pronouns next to the timestamp on their messages

import { TautPlugin } from '$taut'

type Message = { user?: string; bot_id?: string }

type BroadcastPreambleProps = {
  msg?: Message
  children?: React.ReactNode
}

// the thread pane builds its header itself instead of taking children
type ThreadHeaderProps = {
  msg?: Message
  adjacent?: boolean
  visible?: boolean
  omitTimestamp?: boolean
  omitLinebreak?: boolean
}

const MAX_LENGTH = 40

const USER_ID_RE = /^[UW][A-Z0-9]+$/
const isPerson = (
  msg: Message | undefined
): msg is Message & { user: string } =>
  !!msg?.user &&
  USER_ID_RE.test(msg.user) &&
  msg.user !== 'USLACKBOT' &&
  !msg.bot_id

// grouped messages get the same children back with visible: false
const isHeaderChild = (child: React.ReactNode, prop: string): boolean => {
  const props = React.isValidElement(child) ? child.props : null
  if (typeof props !== 'object' || props === null) return false
  return prop in props && (props as { visible?: boolean }).visible !== false
}

const isTimestamp = (child: React.ReactNode) =>
  isHeaderChild(child, 'clickable')

// compact mode moves the timestamp to the left gutter, so sit after the sender
const isSender = (child: React.ReactNode) =>
  isHeaderChild(child, 'isInteractive')

export default class UserPronouns extends TautPlugin<typeof UserPronouns> {
  static readonly id = 'UserPronouns'
  static readonly pluginName = 'User Pronouns'
  static readonly description =
    "Shows people's pronouns next to the timestamp on their messages"
  static readonly authors = ['jeremy'] as const
  static readonly category = 'messages'
  static readonly defaultConfig = {
    enabled: true,
  }

  private readonly Pronouns = ({
    userId,
    bulleted,
  }: {
    userId: string
    bulleted: boolean
  }) => {
    const member = this.api.members.useMember(userId)
    const pronouns = String(member?.profile?.pronouns ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!pronouns) return null
    return (
      <span
        className={`taut-pronouns${bulleted ? ' taut-pronouns--bulleted' : ''}`}
        data-stringify-ignore=""
      >
        {pronouns.slice(0, MAX_LENGTH)}
      </span>
    )
  }

  start() {
    this.api.setStyle(
      `
        .taut-pronouns {
          margin-left: 6px;
          font-size: 12px;
          font-weight: 400;
          color: rgba(var(--sk_foreground_max_solid, 97, 96, 97), 1);
          white-space: nowrap;
          cursor: default;
          user-select: none;
          align-self: center;
        }

        .taut-pronouns--bulleted {
          margin-left: 0;
        }

        .taut-pronouns--bulleted::before {
          content: '\\2022';
          margin: 0 4px;
        }
      `
    )

    // the component handed both the sender and the timestamp, in channels
    this.api.patchComponent<BroadcastPreambleProps>(
      'BroadcastPreamble',
      (Original) => (props) => {
        if (!isPerson(props.msg)) return <Original {...props} />

        const children = React.Children.toArray(props.children)
        const timestamp = children.findIndex(isTimestamp)
        const anchor =
          timestamp === -1 ? children.findIndex(isSender) : timestamp
        if (anchor === -1) return <Original {...props} />

        children.splice(
          anchor + 1,
          0,
          <this.Pronouns
            key="taut-pronouns"
            userId={props.msg.user}
            bulleted={timestamp !== -1}
          />
        )
        return <Original {...props}>{children}</Original>
      }
    )

    // the thread-pane counterpart, which ends on a <br> we have to be aware of
    this.api.patchComponent<ThreadHeaderProps>(
      'ThreadSenderAndTimestampGeneric',
      (Original) => (props) => {
        if (props.adjacent || props.visible === false || !isPerson(props.msg))
          return <Original {...props} />

        return (
          <>
            <Original {...props} omitLinebreak />
            <this.Pronouns
              userId={props.msg.user}
              bulleted={!props.omitTimestamp}
            />
            {props.omitLinebreak ? null : <br />}
          </>
        )
      }
    )

    this.log('Started')
  }
}
