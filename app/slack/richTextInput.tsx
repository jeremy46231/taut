import { type Block, blocksPromise, type Delta } from './blocks'
import { lazyComponent } from './react'
import { byName, waitForExport } from './webpack'

export type RichTextInputProps = {
  /** initial value only: the field is uncontrolled after mount */
  value: Block[]
  /** every edit, with its length the way Slack counts it against `maxLength` */
  onChange: (blocks: Block[], length: number) => void
  /** focus left the field, and not just for a moment as Quill refocuses */
  onBlur?: () => void
  placeholder?: string
  ariaLabel?: string
  id?: string
  /** shows Slack's character counter, and its error once over */
  maxLength?: number
  numMinLines?: number
  disabled?: boolean
}

type Contents = { contents?: Delta['ops'] }
type Texty = { getContents(): Contents | undefined }

const WysiwygContainer = lazyComponent<any>('WysiwygContainer')
const TextyInput = lazyComponent<any>('texty_input_with_autocomplete')
const CharacterCount = lazyComponent<any>('CharacterCount')
const contentsToText = waitForExport<(contents?: Contents) => string>(
  byName('convertContentsToStringForDisplay')
)

export function RichTextInput({
  value,
  onChange,
  onBlur,
  placeholder,
  ariaLabel,
  id,
  maxLength,
  numMinLines = 3,
  disabled = false,
}: RichTextInputProps) {
  const texty = React.useRef<Texty>(null)
  const root = React.useRef<HTMLDivElement>(null)
  const windowRef = React.useMemo(() => new WeakRef(window), [])
  const [initial, setInitial] = React.useState<Contents>()
  const [length, setLength] = React.useState(0)
  const change = React.useRef(onChange)
  change.current = onChange
  const blur = React.useRef(onBlur)
  blur.current = onBlur

  React.useEffect(() => {
    let live = true
    ;(async () => {
      const contents = {
        contents: (await (await blocksPromise).toDelta(value)).ops,
      }
      const text = (await contentsToText)(contents)
      if (!live) return
      setLength(text.length)
      setInitial(contents)
    })()
    return () => {
      live = false
    }
  }, [])

  // the div appears with `initial`
  React.useEffect(() => {
    const element = root.current
    if (!element) return
    // picking a completion blurs and refocuses the editor
    const onFocusOut = () =>
      setTimeout(() => {
        if (!element.contains(document.activeElement)) blur.current?.()
      })
    element.addEventListener('focusout', onFocusOut)
    return () => element.removeEventListener('focusout', onFocusOut)
  }, [initial])

  const onTextChange = React.useCallback(async () => {
    const contents = texty.current?.getContents()
    const { fromDraft } = await blocksPromise
    const blocks = await fromDraft(contents?.contents ?? [], {
      trimStartingWhitespace: true,
    })
    const count = (await contentsToText)(contents).length
    setLength(count)
    change.current(blocks, count)
  }, [])

  if (!initial) return null
  const over = maxLength !== undefined && length > maxLength
  const field = (
    <WysiwygContainer
      numMinLines={numMinLines}
      errors={
        over
          ? [
              {
                id: 'character_limit_reached',
                message: `${maxLength} characters maximum`,
              },
            ]
          : undefined
      }
      enableEmojiButton
      enableComposerButton
      isDisabled={disabled}
    >
      <TextyInput
        ref={texty}
        windowRef={windowRef}
        id={id}
        initialText={initial}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        onTextChange={onTextChange}
        isDisabled={disabled}
        disableTags
        size="medium"
        useWysiwyg
        enterCreatesNewlineOverride
        completeOnEmoji
        completeOnMembers
        completeOnChannels
      />
    </WysiwygContainer>
  )
  return (
    <div ref={root}>
      {maxLength === undefined ? (
        field
      ) : (
        <CharacterCount
          maxCharacterLimit={maxLength}
          currentCount={length}
          type="multiline"
        >
          {field}
        </CharacterCount>
      )}
    </div>
  )
}
