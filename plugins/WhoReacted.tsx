// Shows the avatars of everyone who reacted next to each reaction

import { opt, TautPlugin } from '$taut'

type ReactionProps = { users?: string[] }

// stable identity, so context consumers don't rerender
const NO_REACTORS: string[] = []

export default class WhoReacted extends TautPlugin<typeof WhoReacted> {
  static readonly id = 'WhoReacted'
  static readonly pluginName = 'Who Reacted'
  static readonly description =
    'Shows the avatars of everyone who reacted next to each reaction'
  static readonly authors = ['jeremy', 'rowan'] as const
  static readonly category = 'messages'
  static readonly defaultConfig = {
    enabled: false,
    maxAvatars: opt.number(
      4,
      'how many avatars to show before the rest collapse into a +N',
      { min: 1, max: 20 }
    ),
  }

  private readonly ReactorsContext = React.createContext<string[]>(NO_REACTORS)
  private readonly Avatar = ({ userId }: { userId: string }) => {
    const profile = this.api.members.useMember(userId)?.profile
    // members with no avatar_hash yet get a url that 404s
    const [broken, setBroken] = React.useState(false)
    const url = profile?.image_24 ?? profile?.image_48
    if (!url || broken) return null
    return (
      <img
        className="taut-reactors__avatar"
        src={url}
        alt=""
        onError={() => setBroken(true)}
      />
    )
  }

  private readonly Reactors = () => {
    const users = React.useContext(this.ReactorsContext)
    if (!users.length) return null
    const shown = users.slice(0, this.config.maxAvatars)
    const rest = users.length - shown.length
    return (
      <span className="taut-reactors">
        {shown.map((userId) => (
          <this.Avatar key={userId} userId={userId} />
        ))}
        {rest > 0 && <span className="taut-reactors__overflow">+{rest}</span>}
      </span>
    )
  }

  start() {
    this.api.setStyle(
      `
        .taut-reactors {
          display: inline-flex;
          align-items: center;
          margin-left: 4px;
        }

        .taut-reactors__avatar {
          width: 16px;
          height: 16px;
          margin-left: -5px;
          border-radius: 50%;
          object-fit: cover;
          /* matches the pill so overlapping avatars stay separated */
          border: 1px solid var(--dt_color-surf-pry);
          background-color: var(--dt_color-surf-pry);
        }

        .taut-reactors__avatar:first-child {
          margin-left: 0;
        }

        .taut-reactors__overflow {
          margin-left: 3px;
          font-size: 11px;
          font-weight: 700;
          line-height: 1;
        }
      `
    )

    this.api.patchComponent<ReactionProps>(
      'Reaction',
      (Original) => (props) => (
        <this.ReactorsContext.Provider value={props.users ?? NO_REACTORS}>
          <Original {...props} />
        </this.ReactorsContext.Provider>
      )
    )

    // last child inside the reaction button, so the avatars land in the pill
    this.api.patchComponent('ReactionAnimation', (Original) => (props) => (
      <>
        <Original {...props} />
        <this.Reactors />
      </>
    ))

    this.log('Started')
  }
}
