// Uploads an audio file as your name recording, instead of recording one

import { TautPlugin } from '$taut'

type AudioButtonProps = {
  onChangeFile?: (fileId: string | null) => void
  onFileUploadStart?: () => void
  onFileUploadEnd?: () => void
}

/** the mp3 they chose, or null if they closed the picker */
function pickAudio(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    Object.assign(input, { type: 'file', accept: 'audio/mpeg,.mp3' })
    input.style.display = 'none'
    const done = (file: File | null) => {
      resolve(file)
      input.remove()
    }
    input.addEventListener('change', () => done(input.files?.[0] ?? null), {
      once: true,
    })
    input.addEventListener('cancel', () => done(null), { once: true })
    document.body.appendChild(input)
    input.click()
  })
}

/** the waveform Slack draws, one peak per bar, each 0-100 */
function peaks(channel: Float32Array, count: number): number[] {
  const width = Math.max(1, Math.floor(channel.length / count))
  return Array.from({ length: count }, (_, bar) => {
    const start = bar * width
    const end = Math.min(channel.length, start + width)
    let peak = 0
    for (let i = start; i < end; i++)
      peak = Math.max(peak, Math.abs(channel[i] ?? 0))
    return Math.round(peak * 100)
  })
}

export default class CustomNameRecording extends TautPlugin<
  typeof CustomNameRecording
> {
  static readonly id = 'CustomNameRecording'
  static readonly pluginName = 'Custom Name Recording'
  static readonly description =
    'Uploads an audio file as your name recording, instead of recording one'
  static readonly authors = ['jeremy'] as const
  static readonly category = 'people'
  static readonly defaultConfig = {
    enabled: true,
  }

  start(): void {
    this.api.patchComponent<AudioButtonProps>(
      'EditAudioButton',
      (Original) => (props) => (
        <>
          <Original {...props} />
          <this.UploadButton {...props} />
        </>
      )
    )

    this.api.setStyle(`
      .taut-name-recording__upload { margin-left: 8px; }
      .taut-name-recording__error { margin-top: 4px; }
    `)

    this.log('Started')
  }

  private UploadButton = (props: AudioButtonProps) => {
    const { Button, SvgIcon, InlineAlert } = this.api.elements
    const [busy, setBusy] = React.useState<string | null>(null)
    const [error, setError] = React.useState<string | null>(null)

    const onClick = () => {
      setError(null)
      this.upload(props, setBusy)
        .catch((err) => setError(err?.message || 'Could not upload that file'))
        .finally(() => setBusy(null))
    }

    return (
      <>
        <Button
          className="taut-name-recording__upload"
          type="outline"
          size="medium"
          onClick={onClick}
          disabled={busy !== null}
        >
          <SvgIcon name="file-upload" size={18} inline />
          <span className="margin_left_25">{busy ?? 'Upload audio'}</span>
        </Button>
        {error ? (
          <InlineAlert className="taut-name-recording__error c-inline_alert--level_error">
            {error}
          </InlineAlert>
        ) : null}
      </>
    )
  }

  private async upload(
    props: AudioButtonProps,
    setBusy: (label: string | null) => void
  ) {
    const source = await pickAudio()
    if (!source) return

    setBusy('Checking...')
    const file = await this.describe(source)

    setBusy('Uploading...')
    props.onFileUploadStart?.()
    try {
      props.onChangeFile?.(await this.api.files.upload(file))
    } finally {
      props.onFileUploadEnd?.()
    }
  }

  // Slack reads these off the file rather than measuring it
  private async describe(source: File) {
    const context = new AudioContext()
    try {
      const audio = await context.decodeAudioData(await source.arrayBuffer())
      const bars = Math.min(100, Math.max(20, Math.round(audio.duration * 5)))
      return Object.assign(
        new File([source], 'audio_name_pronunciation.mp3', {
          type: 'audio/mpeg',
        }),
        {
          subtype: 'slack_name_pronunciation',
          duration: audio.duration,
          audio_wave_samples: peaks(audio.getChannelData(0), bars),
        }
      )
    } catch {
      throw new Error('That file could not be read as audio')
    } finally {
      context.close()
    }
  }
}
