// Save favorite GIFs and reuse them from Slack's GIF picker

import { type ComponentType, TautPlugin } from '$taut'

type SavedGif = {
  id: string
  url: string
  previewUrl: string
  name: string
  width: number
  height: number
  bytes: number
  previewBytes: number
  fileId?: string
  teamId?: string
}

type GifSelection = Omit<SavedGif, 'id' | 'url' | 'fileId' | 'teamId'> & {
  originalGifUrl: string
}

type GifFile = {
  id: string
  mimetype?: string
  filetype?: string
  title?: string
  name?: string
  url_private?: string
  thumb_360?: string
  thumb_480?: string
  original_w?: number
  original_h?: number
  size?: number
}

type DraftTarget = {
  draftId?: string
  channelId?: string
  threadTs?: string
}

type AttachmentImageProps = {
  url: string
  title?: string
  originalWidth?: number
  originalHeight?: number
  width?: number
  height?: number
}

type PickerProps = {
  adjustGifPickerHeightToAccommodateEmojiPicker?: string
  onGifSelected?: (event: React.MouseEvent, gif: GifSelection) => void
  onClosed: (event: React.MouseEvent) => void
}

export default class SavedGifs extends TautPlugin<typeof SavedGifs> {
  static readonly id = 'SavedGifs'
  static readonly pluginName = 'Saved GIFs'
  static readonly description =
    "Save favorite GIFs and reuse them from Slack's GIF picker"
  static readonly authors = [
    { name: 'christianwell', url: 'https://github.com/christianwell' },
  ]
  static readonly category = 'messageBox'
  static readonly defaultConfig = { enabled: false }

  private readonly gifs = this.api.storage.store<SavedGif[]>('gifs', [])
  private readonly DraftContext = React.createContext<DraftTarget>({})
  private readonly animatedImages = new Map<string, Promise<boolean>>()

  private fileGif(file: GifFile, teamId: string): SavedGif | undefined {
    if (
      (file.mimetype !== 'image/gif' && file.filetype !== 'gif') ||
      !file.url_private
    )
      return undefined
    return {
      id: `file:${teamId}:${file.id}`,
      fileId: file.id,
      teamId,
      url: file.url_private,
      previewUrl: file.thumb_360 || file.thumb_480 || file.url_private,
      name: file.title || file.name || 'GIF',
      width: file.original_w ?? 0,
      height: file.original_h ?? 0,
      bytes: file.size ?? 0,
      previewBytes: 0,
    }
  }

  private readonly MessageImage = ({
    Original,
    props,
  }: {
    Original: ComponentType<AttachmentImageProps>
    props: AttachmentImageProps
  }) => {
    const [gif, setGif] = React.useState<SavedGif>()
    React.useEffect(() => {
      let cancelled = false
      setGif(undefined)
      const findGif = async () => {
        const getFileId = await this.api.waitForExport<
          (state: any, url: string) => string | null
        >(this.api.byName('getFileIdFromUrlWithState'))
        const state = this.api.redux.getRawState()
        const fileId = getFileId(state, props.url)
        if (fileId) {
          const file = state?.files?.[fileId] as GifFile | undefined
          const teamId = state?.selfTeamIds?.teamId as string | undefined
          if (file && teamId && !cancelled) setGif(this.fileGif(file, teamId))
          return
        }

        const url = new URL(props.url, location.href)
        const originalUrl = url.searchParams.get('url') || url.href
        let animated = /\.gif(?:$|[?#])/i.test(originalUrl)
        if (!animated) {
          let check = this.animatedImages.get(originalUrl)
          if (!check) {
            check = (async () => {
              const getProxy = await this.api.waitForExport<
                (state: any, options: { url: string }) => string
              >(this.api.byName('getImgProxyUrl'))
              const isAnimated = await this.api.waitForExport<
                (url: string) => Promise<boolean>
              >(this.api.byName('isImageAnimated'))
              return isAnimated(
                getProxy(this.api.redux.getRawState(), { url: originalUrl })
              )
            })().catch(() => false)
            this.animatedImages.set(originalUrl, check)
          }
          animated = await check
        }
        if (cancelled || !animated) return
        const giphyId =
          /^https:\/\/media\d*\.giphy\.com\/media\/([^/]+)\//.exec(
            originalUrl
          )?.[1]
        setGif({
          id: giphyId || `url:${originalUrl}`,
          url: originalUrl,
          previewUrl: props.url,
          name: props.title || 'GIF',
          width: props.originalWidth ?? props.width ?? 0,
          height: props.originalHeight ?? props.height ?? 0,
          bytes: 0,
          previewBytes: 0,
        })
      }
      findGif().catch((error) => this.log('Could not identify GIF', error))
      return () => {
        cancelled = true
      }
    }, [
      props.url,
      props.title,
      props.originalWidth,
      props.originalHeight,
      props.width,
      props.height,
    ])
    if (!gif) return <Original {...props} />
    return (
      <div className="taut-saved-gifs__message">
        <Original {...props} />
        <this.SaveButton gif={gif} />
      </div>
    )
  }

  private save(gif: SavedGif, saved: boolean) {
    this.gifs
      .update((gifs) =>
        saved
          ? gifs.filter((item) => item.id !== gif.id)
          : [gif, ...gifs.filter((item) => item.id !== gif.id)]
      )
      .catch((error) => {
        this.log('Could not save GIFs', error)
        this.api.modal.alert({
          title: 'Could not save GIFs',
          body: 'Your favorites could not be saved. Please try again.',
        })
      })
  }

  private readonly SaveButton = ({ gif }: { gif: SavedGif }) => {
    const saved = this.gifs.use().some((item) => item.id === gif.id)
    return (
      <button
        type="button"
        className="c-button-unstyled taut-saved-gifs__star"
        aria-label={`${saved ? 'Unsave' : 'Save'} ${gif.name || 'GIF'}`}
        aria-pressed={saved}
        title={saved ? 'Remove from saved GIFs' : 'Save GIF'}
        data-stringify-ignore="true"
        onClick={(event) => {
          event.stopPropagation()
          this.save(gif, saved)
        }}
      >
        {saved ? '★' : '☆'}
      </button>
    )
  }

  private readonly Picker = ({
    Original,
    props,
  }: {
    Original: ComponentType<PickerProps>
    props: PickerProps
  }) => {
    const target = React.useContext(this.DraftContext)
    const teamId = this.api.redux.useReduxState<string>(
      (state) => state.selfTeamIds?.teamId
    )
    const gifs = this.gifs
      .use()
      .filter((gif) => !gif.teamId || gif.teamId === teamId)
    const [saved, setSaved] = React.useState(false)
    const [query, setQuery] = React.useState('')
    const visible = gifs.filter((gif) =>
      gif.name.toLowerCase().includes(query.toLowerCase())
    )
    return (
      <div
        className={`p-gif_picker taut-saved-gifs ${props.adjustGifPickerHeightToAccommodateEmojiPicker ? `p-gif_picker--${props.adjustGifPickerHeightToAccommodateEmojiPicker}` : ''}`}
      >
        <nav className="taut-saved-gifs__navigation" aria-label="GIF views">
          <button
            type="button"
            className="c-button-unstyled"
            aria-pressed={!saved}
            onClick={() => setSaved(false)}
          >
            Browse
          </button>
          <button
            type="button"
            className="c-button-unstyled"
            aria-pressed={saved}
            onClick={() => setSaved(true)}
          >
            Saved ({gifs.length})
          </button>
        </nav>
        <div hidden={saved} className="taut-saved-gifs__browse">
          <Original {...props} />
        </div>
        {saved && (
          <section className="p-gif_picker taut-saved-gifs__saved">
            <header className="p-gif_picker__header">
              <input
                className="c-input_text"
                aria-label="Search saved GIFs"
                placeholder="Search saved GIFs"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </header>
            <div className="taut-saved-gifs__grid">
              {visible.map((gif) => (
                <div className="taut-saved-gifs__tile" key={gif.id}>
                  <button
                    type="button"
                    className="c-button-unstyled taut-saved-gifs__image"
                    aria-label={`Add ${gif.name || 'GIF'} to draft`}
                    onClick={(event) => {
                      if (gif.fileId) {
                        if (!target.draftId || !target.channelId) return
                        this.api
                          .userAPI<{ file: GifFile }>(
                            'files.info',
                            {
                              file: gif.fileId,
                            },
                            { signal: this.api.signal }
                          )
                          .then(() =>
                            Promise.race([
                              this.api.redux.waitForThunkCreator(
                                'attachFileToDraft'
                              ),
                              new Promise<never>((_, reject) =>
                                setTimeout(
                                  () =>
                                    reject(
                                      new Error(
                                        'Slack file attachment is unavailable'
                                      )
                                    ),
                                  3000
                                )
                              ),
                            ])
                          )
                          .then(() => {
                            if (this.api.signal.aborted) return
                            return this.api.redux.dispatchThunk(
                              'attachFileToDraft',
                              {
                                ...target,
                                fileId: gif.fileId,
                                isFromComposer: false,
                                reason: 'taut-saved-gifs',
                              }
                            )
                          })
                          .then(() => {
                            if (!this.api.signal.aborted) props.onClosed(event)
                          })
                          .catch((error) => {
                            if (this.api.signal.aborted) return
                            this.log('Could not attach saved GIF', error)
                            this.api.modal.alert({
                              title: 'Could not add GIF',
                              body: 'This file may have been deleted, or you may no longer have access to it.',
                            })
                          })
                      } else {
                        props.onClosed(event)
                        const {
                          id: _id,
                          url,
                          fileId: _fileId,
                          teamId: _teamId,
                          ...selection
                        } = gif
                        props.onGifSelected?.(event, {
                          ...selection,
                          originalGifUrl: url,
                        })
                      }
                    }}
                    disabled={
                      !!gif.fileId && (!target.draftId || !target.channelId)
                    }
                  >
                    <img src={gif.previewUrl} alt={gif.name} />
                  </button>
                  <this.SaveButton gif={gif} />
                </div>
              ))}
              {!visible.length && (
                <p className="taut-saved-gifs__empty">
                  {gifs.length
                    ? 'No saved GIFs match your search.'
                    : 'Star a GIF in a message or in Browse to save it here.'}
                </p>
              )}
            </div>
          </section>
        )}
      </div>
    )
  }

  async start() {
    await this.gifs.ready
    this.api.setStyle(`
      .taut-saved-gifs { display: flex; flex-direction: column; padding-top: 0; }
      .taut-saved-gifs__navigation { display: flex; flex-shrink: 0; gap: 8px; padding: 8px 12px; border-bottom: 1px solid rgba(var(--sk_primary_foreground), .13); }
      .taut-saved-gifs__navigation button { padding: 4px 8px; border-radius: 6px; color: rgba(var(--sk_primary_foreground), .7); }
      .taut-saved-gifs__navigation button[aria-pressed="true"] { background: rgba(var(--sk_primary_foreground), .1); color: rgba(var(--sk_primary_foreground), 1); font-weight: 700; }
      .taut-saved-gifs__browse { flex: 1; min-height: 0; }
      .taut-saved-gifs .p-gif_picker { height: 100%; min-height: 0; max-height: none; }
      .taut-saved-gifs__saved { flex: 1; min-height: 0; }
      .taut-saved-gifs__grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-content: start; gap: 8px; padding: 12px; overflow-y: auto; min-height: 0; }
      .taut-saved-gifs__tile { position: relative; min-width: 0; }
      .taut-saved-gifs__message { position: relative; display: inline-flex; max-width: 100%; vertical-align: top; }
      .p-gif_picker__row > .taut-saved-gifs__tile { flex: 0 0 calc((100% - 18px) / 3); margin-right: 6px; }
      .p-gif_picker__masonry_cell > .taut-saved-gifs__tile { height: 100%; }
      .taut-saved-gifs__tile > .p-gif_picker__row_item,
      .taut-saved-gifs__tile > .p-gif_picker__row_item--disable-animations { width: 100%; margin-right: 0; }
      .taut-saved-gifs__image { display: block; width: 100%; height: 104px; }
      .taut-saved-gifs__image img { width: 100%; height: 100%; object-fit: cover; border-radius: 6px; }
      .taut-saved-gifs__star { position: absolute; top: 4px; right: 4px; z-index: 1; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; background: rgba(var(--sk_primary_background), 1); color: rgba(var(--sk_primary_foreground), 1); font-size: 22px; box-shadow: 0 1px 4px #0004; }
      .taut-saved-gifs__star[aria-pressed="true"] { color: #ecb22e; }
      .taut-saved-gifs__star:hover { box-shadow: 0 0 0 2px rgba(var(--sk_primary_foreground), .3); }
      .taut-saved-gifs__star:focus-visible { outline: 2px solid rgba(var(--sk_primary_foreground), 1); outline-offset: 2px; }
      .taut-saved-gifs__empty { grid-column: 1 / -1; text-align: center; padding: 24px 8px; color: rgba(var(--sk_primary_foreground), .7); }
    `)
    this.api.patchComponent<DraftTarget>(
      'TextyButtons',
      (Original) => (props) => (
        <this.DraftContext.Provider
          value={{
            draftId: props.draftId,
            channelId: props.channelId,
            threadTs: props.threadTs,
          }}
        >
          <Original {...props} />
        </this.DraftContext.Provider>
      )
    )
    this.api.patchComponent<{ file: GifFile; teamId: string }>(
      'FileImageThumbnail',
      (Original) => (props) => {
        const gif = this.fileGif(props.file, props.teamId)
        if (!gif) return <Original {...props} />
        // The thumbnail is absolutely positioned in Slack's aspect box.
        // Keep that containing block rather than adding a wrapper around it.
        return (
          <>
            <Original {...props} />
            <this.SaveButton gif={gif} />
          </>
        )
      }
    )
    this.api.patchComponent<AttachmentImageProps>(
      'AttachmentImage',
      (Original) => (props) => (
        <this.MessageImage Original={Original} props={props} />
      )
    )
    this.api.patchComponent<SavedGif>('GifListItem', (Original) => (props) => {
      const { id, url, previewUrl, name, width, height, bytes, previewBytes } =
        props
      const gif = {
        id,
        url,
        previewUrl,
        name,
        width,
        height,
        bytes,
        previewBytes,
      }
      return (
        <div className="taut-saved-gifs__tile">
          <Original {...props} />
          <this.SaveButton gif={gif} />
        </div>
      )
    })
    // Slack's picker is unnamed inside withWindow; match its own render source.
    this.api.patchComponent<PickerProps>(
      {
        filter: (component) =>
          typeof component === 'function' &&
          component.toString().includes('gif-picker-host') &&
          component
            .toString()
            .includes('adjustGifPickerHeightToAccommodateEmojiPicker'),
      },
      (Original) => (props) => <this.Picker Original={Original} props={props} />
    )
  }
}
