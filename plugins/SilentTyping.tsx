// Suppresses typing indicators so others can't see when you're typing

import { TautPlugin } from '$taut'

export default class SilentTyping extends TautPlugin {
  static readonly id = 'SilentTyping'
  static readonly pluginName = 'Silent Typing'
  static readonly description =
    "Adds a button to suppress typing indicators so others can't see when you're typing"
  static readonly authors = '<@U06UYA5GMB5>, <@U080A3QP42C>, <@U01D9DWGEB0>'
  static readonly defaultConfig = `
    // Adds a button to suppress typing indicators so others can't see when you're typing
    "SilentTyping": {
      "enabled": true
    }
  `

  private static readonly STORAGE_KEY = 'taut_silent_typing_suppressed'
  private suppressed = false
  private readonly listeners = new Set<(v: boolean) => void>()

  private setSuppressed(v: boolean) {
    this.suppressed = v
    localStorage.setItem(SilentTyping.STORAGE_KEY, String(v))
    for (const l of this.listeners) l(v)
  }

  start(): void {
    this.suppressed = localStorage.getItem(SilentTyping.STORAGE_KEY) === 'true'

    for (const name of ['MessagePaneInput', 'InputContainer'] as const) {
      this.api.patchComponent<{
        currentUserStartedTyping?: () => void
        currentUserEndedTyping?: () => void
      }>(name, (Original) => (props) => {
        const [isSuppressed, setIsSuppressed] = React.useState(this.suppressed)

        React.useEffect(() => {
          this.listeners.add(setIsSuppressed)
          return () => {
            this.listeners.delete(setIsSuppressed)
          }
        }, [])

        if (isSuppressed) {
          props = {
            ...props,
            currentUserStartedTyping: () => {},
            currentUserEndedTyping: () => {},
          }
        }

        return <Original {...props} />
      })
    }

    const Tooltip = this.api.elements.Tooltip
    const IconButtonBase = this.api.elements.IconButtonBase
    const SvgIcon = this.api.elements.SvgIcon

    this.api.patchComponent<object>('TextyButtons', (Original) => (props) => {
      const [isSuppressed, setIsSuppressed] = React.useState(this.suppressed)

      React.useEffect(() => {
        this.listeners.add(setIsSuppressed)
        return () => {
          this.listeners.delete(setIsSuppressed)
        }
      }, [])

      const label = isSuppressed
        ? 'Allow typing notifications'
        : 'Suppress typing notifications'

      return (
        <div
          className="taut-silent-typing-wrapper"
          style={{ display: 'flex', alignItems: 'center' }}
        >
          <Original {...props} />
          <Tooltip
            tip={label}
            position="top"
            offsetY={-7}
            delay={500}
            zIndex="above_fs"
          >
            <IconButtonBase
              aria-pressed={String(isSuppressed)}
              aria-label={label}
              onClick={() => this.setSuppressed(!isSuppressed)}
              tabIndex={-1}
              size="smedium"
            >
              <SvgIcon
                name={
                  isSuppressed
                    ? 'notifications-off'
                    : 'notifications' /* notifications-all-new-posts */
                }
                size={18}
              />
            </IconButtonBase>
          </Tooltip>
        </div>
      )
    })

    this.api.setStyle(
      'silent-typing',
      `.taut-silent-typing-wrapper .c-texty_buttons { flex: 1; min-width: 0; }`
    )

    this.log('Started')
  }
}
