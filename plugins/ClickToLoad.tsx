// Holds Spotify, SoundCloud and other music embeds until you click to load them

import { opt, TautPlugin } from '$taut'

type AttachmentMediaProps = {
  imageUrl?: string | null
  videoHtml?: string | null
  audioHtml?: string | null
  audioHtmlHeight?: number | null
}

type Provider = 'spotify' | 'soundcloud' | 'appleMusic' | 'other'

const PROVIDERS: { key: Provider; label: string; domain: string }[] = [
  { key: 'spotify', label: 'Spotify', domain: 'spotify.com' },
  { key: 'soundcloud', label: 'SoundCloud', domain: 'soundcloud.com' },
  { key: 'appleMusic', label: 'Apple Music', domain: 'music.apple.com' },
]

const decodeEntities = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

function embedSource(html: string): URL | undefined {
  const src = /<iframe\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(html)
  if (!src) return undefined
  try {
    const url = new URL(decodeEntities(src[1] ?? src[2] ?? ''))
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url
      : undefined
  } catch {
    return undefined
  }
}

function providerFor(url: URL): { key: Provider; label: string } {
  const host = url.hostname
  const known = PROVIDERS.find(
    ({ domain }) => host === domain || host.endsWith(`.${domain}`)
  )
  return known ?? { key: 'other', label: host.replace(/^www\./, '') }
}

export default class ClickToLoad extends TautPlugin<typeof ClickToLoad> {
  static readonly id = 'ClickToLoad'
  static readonly pluginName = 'Click to Load'
  static readonly description =
    'Holds Spotify, SoundCloud and other music embeds until you click to load them'
  static readonly authors = ['jeremy', 'rowan'] as const
  static readonly category = 'privacy'
  static readonly defaultConfig = {
    enabled: false,
    spotify: opt(true, 'Hold Spotify embeds until clicked'),
    soundcloud: opt(true, 'Hold SoundCloud embeds until clicked', {
      label: 'SoundCloud',
    }),
    appleMusic: opt(true, 'Hold Apple Music embeds until clicked', {
      label: 'Apple Music',
    }),
    other: opt(true, 'Hold embeds from any other site until clicked'),
  }

  /** embeds clicked this session, so scrolling away and back keeps them */
  private readonly loaded = new Set<string>()

  start() {
    // only audio_html needs holding, Slack already puts video_html behind a play button
    this.api.patchComponent<AttachmentMediaProps>(
      'AttachmentMedia',
      (Original) => (props) => {
        const [, rerender] = React.useReducer((n: number) => n + 1, 0)
        const html = props.audioHtml
        // image and video win over audio when an unfurl carries several
        const url =
          html && !props.imageUrl && !props.videoHtml
            ? embedSource(html)
            : undefined
        const provider = url && providerFor(url)
        if (
          !url ||
          !provider ||
          this.config[provider.key] === false ||
          this.loaded.has(url.href)
        )
          return <Original {...props} />

        return (
          <this.Placeholder
            label={provider.label}
            height={props.audioHtmlHeight ?? undefined}
            onLoad={() => {
              this.loaded.add(url.href)
              rerender()
            }}
          />
        )
      }
    )

    this.api.setStyle(`
      .taut-click-to-load .c-message_attachment__video_thumb {
        min-height: 72px;
        background-color: rgba(var(--sk_foreground_min_solid, 248, 248, 248), 1);
      }
      .taut-click-to-load__label {
        display: block;
        padding-bottom: 8px;
        color: var(--dt_color-constants-white);
        font-size: 13px;
        font-weight: 700;
      }
    `)

    this.log('Started')
  }

  /** Slack's click-to-play for video unfurls */
  private Placeholder = ({
    label,
    height,
    onLoad,
  }: {
    label: string
    height?: number
    onLoad: () => void
  }) => (
    <div
      className="c-message_attachment__audio taut-click-to-load"
      style={{ height }}
      data-stringify-ignore="true"
    >
      <div className="c-message_attachment__video_thumb">
        <div className="c-message_attachment__video_buttons">
          <button
            type="button"
            className="c-button-unstyled c-message_attachment__video_play"
            aria-label={`Load ${label} embed`}
            onClick={onLoad}
          >
            <i
              className="c-deprecated-icon c-icon--play c-deprecated-icon--inherit"
              aria-hidden="true"
            />
          </button>
          <span className="taut-click-to-load__label">{`Load ${label}`}</span>
        </div>
      </div>
    </div>
  )
}
