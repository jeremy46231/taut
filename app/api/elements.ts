import {
  type ComponentType,
  getComponentSource,
  lazyComponent,
  reactPromise,
} from '../slack/react'
import { RichTextInput } from '../slack/richTextInput'

export type SvgIconProps = {
  name: string
  size?: number
  inline?: boolean
}

export type MrkdwnElementProps = {
  text: string
}

export type ButtonProps = {
  type?: 'primary' | 'ghost' | 'outline' | 'danger'
  size?: 'small' | 'medium' | 'large'
  icon?: string
  href?: string
  htmlType?: 'button' | 'submit' | 'reset'
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'size'>

export type TooltipProps = {
  tip: React.ReactNode
  position?: string
  offsetY?: number
  delay?: number
  zIndex?: string
  children?: React.ReactNode
}

export type IconButtonBaseProps = {
  size?: string
  className?: string
  'aria-pressed'?: string
  'aria-label'?: string
  'data-qa'?: string
  onClick?: () => void
  onMouseDown?: React.MouseEventHandler<HTMLButtonElement>
  tabIndex?: number
  children?: React.ReactNode
}

export type ConfirmationModalProps = {
  title?: React.ReactNode
  children?: React.ReactNode
  onSubmit?: () => void
  onCancel?: () => void
  onClose?: () => void
  submitButtonText?: string
  cancelButtonText?: string
  submitButtonType?: 'primary' | 'danger'
  showCancelButton?: boolean
  showSubmitButton?: boolean
  disableSubmitButton?: boolean
}

/** the error line under a form field, warning icon included */
export type InlineAlertProps = {
  children?: React.ReactNode
  className?: string
  id?: string
}

export type LabelProps = {
  text: React.ReactNode
  htmlFor?: string
  subtext?: React.ReactNode
  optional?: boolean
  type?: 'block' | 'inline'
  isDisabled?: boolean
  className?: string
  id?: string
  /** a control to wrap, e.g. a checkbox with `type: 'inline'` */
  children?: React.ReactNode
}

export type MenuTemplateItem = {
  key: string
  label?: React.ReactNode
  description?: React.ReactNode
  type?: 'submenu' | 'separator' | 'header' | 'custom'
  /** the rows of a `submenu` item */
  template?: MenuTemplateItem[]
  /** an `SvgIcon` name */
  icon?: string
  click?: (e?: unknown) => void
  disabled?: boolean
  danger?: boolean
}

/** Slack's two-field date range control with a calendar popover */
export type DateRangePickerProps = {
  id?: string
  className?: string
  /** initial value only: the picker is uncontrolled after mount */
  selectedStartDate?: string | null
  selectedEndDate?: string | null
  /** only report the new value, the picker keeps its own state */
  onStartDateChange?: (change: { selectedStartDate: string }) => void
  onEndDateChange?: (change: { selectedEndDate: string }) => void
  /** how dates are parsed and reported back, defaults to "YYYY-MM-DD" */
  dateFormat?: string
  /** how dates are shown, when it should differ from `dateFormat` */
  displayFormat?: string | null
  disabledDates?: string[]
  disableDatesBefore?: string
  disableDatesAfter?: string
  /** cap the span the user can pick, in days */
  maxRange?: number
  size?: 'small' | 'medium' | 'large'
  width?: number | null
  placeholderText?: string | null
  startInputPlaceholder?: string
  endInputPlaceholder?: string
  startInputAriaLabel?: string
  endInputAriaLabel?: string
  showClearSelection?: boolean
  endDateRequired?: boolean
  singleMonthMode?: boolean
  showPreviousMonth?: boolean
  closeAfterSelection?: boolean
  renderCalendarInPopover?: boolean
  onCalendarClose?: () => void
  dataQa?: string | null
  'aria-label'?: string
}

/** Slack's section wrapper, holding a Legend and its controls */
export type FieldSetProps = {
  id?: string
  'data-qa'?: string
  'data-qa-section'?: string
  children?: React.ReactNode
}

export type LegendProps = {
  className?: string
  children?: React.ReactNode
}

/** secondary line under a control */
export type HintProps = {
  children?: React.ReactNode
  className?: string
}

export type SelectOption = { label: string; value: string }

export type BasicSelectProps = {
  selectId: string
  options: SelectOption[]
  selectedOption?: SelectOption
  onSelectionChange: (option: SelectOption) => void
  /** pixels, or a CSS length like "100%" */
  width?: number | string
  ariaLabel?: string
  selectDataQa?: string
  isDisabled?: boolean
}

export type BlocksProps = {
  msg: { blocks?: unknown[]; [key: string]: unknown }
  blocksContainerContext?: 'message' | string
  streaming?: boolean
}

/** Slack's avatar, for either a member (`userId`) or a bot (`botId`) */
export type AvatarProps = {
  userId?: string
  botId?: string
  /** the bot as the message recorded it, used until the store has its own copy */
  botProfile?: object
  /** an image set to draw instead of the member's or bot's own */
  icons?: object
  /** side length in pixels, which also picks the stored image size */
  size?: number
  className?: string
  /** whether it links to the profile and reacts to a click */
  isInteractive?: boolean
  /** open the profile card on hover */
  showCard?: boolean
  showTooltip?: boolean
  messageTs?: string
  ariaHidden?: string
  tabIndex?: number
  'data-qa'?: string
}

/** wraps a trigger so hovering it opens Slack's profile card */
export type ProfileHoverTriggerProps = {
  /** the member whose profile to show */
  memberId?: string
  /** the bot (`B...`) whose app profile to show */
  serviceId?: string
  /** the bot as the message recorded it, used until the store has its own copy */
  botProfile?: object
  messageTs?: string
  position?: string
  /** leave off the wrapper's own class */
  noStyling?: boolean
  children?: React.ReactNode
}

export type MenuFromTemplateProps = { template?: MenuTemplateItem[] }

export type MenuTriggerProps = {
  position?: 'top' | 'bottom' | 'left' | 'right'
  isDisabled?: boolean
  renderMenu: (menuProps: object) => React.ReactNode
  children?: React.ReactNode
}

export type FormTextInputProps = {
  id?: string
  name?: string
  type?: 'text' | 'password'
  value: string
  onChange: (value: string) => void
  onBlur?: React.FocusEventHandler<HTMLInputElement>
  onFocus?: React.FocusEventHandler<HTMLInputElement>
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
  placeholder?: string
  hintText?: string | null
  errorText?: string | null
  isDisabled?: boolean
  isInvalid?: boolean
  isRequired?: boolean
  size?: 'small' | 'medium' | 'large'
  autoFocus?: boolean
  autoComplete?: string
  maxCharacterLimit?: number | null
  className?: string
}

/** Slack's checkbox, the native `c-input_checkbox` */
export type CheckboxProps = {
  checked?: boolean
  onChange?: React.ChangeEventHandler<HTMLInputElement>
  indeterminate?: boolean
  disabled?: boolean
  id?: string
  className?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

/** Slack's time dropdown, which also takes typed times */
export type TimePickerProps = {
  /** 24-hour "HH:MM" */
  value?: string
  onChange?: (time: string) => void
  ariaLabel?: string
  /** how far apart the listed times are */
  optionsHourIncrement?:
    | 'five_minute'
    | 'ten_minute'
    | 'quarter'
    | 'half'
    | 'full'
  size?: 'small' | 'medium'
  /** pixels, or a CSS length */
  width?: number | string
  showTimeZone?: boolean
  isDisabled?: boolean
  isRequired?: boolean
  min?: string
  max?: string
}

/** opens Slack's emoji picker from the element it wraps */
export type EmojiMenuTriggerProps = {
  /** the emoji's name without colons, like "no_entry" */
  onEmojiSelected: (emoji: unknown, name: string) => void
  position?: 'top' | 'bottom' | 'top-left'
  offsetY?: number
  /** one element, not a fragment */
  children: React.ReactElement
}

/** the toggleable pill used for search filters */
export type TagProps = {
  /** like `'informative'` */
  style?: string
  isMicro?: boolean
  children?: React.ReactNode
}

export type FilterPillProps = {
  isActive?: boolean
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  isDisabled?: boolean
  className?: string
  id?: string
  'aria-pressed'?: boolean
  children?: React.ReactNode
}

/** Slack's floating layer, drawn beside `targetBounds` until it's closed */
export type PopoverProps = {
  isOpen: boolean
  targetBounds: DOMRect
  windowRef: WeakRef<Window>
  position?: string
  offsetX?: number
  offsetY?: number
  onClose: () => void
  ariaRole?: string
  ariaLabel?: string
  children?: React.ReactNode
}

/** colors are hex without the `#` (like "e01e5a"), and `value` is only read on mount */
export type HSVPickerProps = {
  value: string
  onChange: (hex: string) => void
  /** also show an opacity slider, and report 8-digit hex */
  alpha?: boolean
  className?: string
}

// other components share these names, so pick slack's by the markup it draws
// TODO: is this janky?
const drawing = (marker: string) => (component: ComponentType) =>
  getComponentSource(component).includes(marker)

export const elementsAPIPromise = (async () => {
  await reactPromise

  return {
    SvgIcon: lazyComponent<SvgIconProps>('SvgIcon'),
    Avatar: lazyComponent<AvatarProps>('ConnectedBaseAvatar'),
    ProfileHoverTrigger: lazyComponent<ProfileHoverTriggerProps>(
      'ProfileHoverTrigger'
    ),
    MrkdwnElement: lazyComponent<MrkdwnElementProps>('MrkdwnElement'),
    Button: lazyComponent<ButtonProps>('Button', drawing('"c-button"')),
    Tooltip: lazyComponent<TooltipProps>(
      'Tooltip',
      drawing('"data-sk":"tooltip"')
    ),
    IconButtonBase: lazyComponent<IconButtonBaseProps>('IconButtonBase'),
    ConfirmationModal:
      lazyComponent<ConfirmationModalProps>('ConfirmationModal'),
    InlineAlert: lazyComponent<InlineAlertProps>('InlineAlert'),
    Label: lazyComponent<LabelProps>('Label', drawing('"c-label"')),
    FormTextInput: lazyComponent<FormTextInputProps>('FormTextInput'),
    Checkbox: lazyComponent<CheckboxProps>('Checkbox'),
    FilterPill: lazyComponent<FilterPillProps>('FilterPill'),
    Tag: lazyComponent<TagProps>('Tag'),
    DateRangePicker: lazyComponent<DateRangePickerProps>('DateRangePicker'),
    FieldSet: lazyComponent<FieldSetProps>('FieldSet'),
    Legend: lazyComponent<LegendProps>('Legend', drawing('"c-legend"')),
    Hint: lazyComponent<HintProps>('Hint'),
    BasicSelect: lazyComponent<BasicSelectProps>('BasicSelect'),
    Blocks: lazyComponent<BlocksProps>('Blocks'),
    MenuTrigger: lazyComponent<MenuTriggerProps>('MenuTrigger'),
    MenuFromTemplate: lazyComponent<MenuFromTemplateProps>('MenuFromTemplate'),
    TimePicker: lazyComponent<TimePickerProps>('TimePicker'),
    EmojiMenuTrigger: lazyComponent<EmojiMenuTriggerProps>(
      'Connect(EmojiMenuTrigger)'
    ),
    Popover: lazyComponent<PopoverProps>('Popover', drawing('"c-popover"')),
    HSVPicker: lazyComponent<HSVPickerProps>('HSVPicker'),
    RichTextInput,
  }
})()

export type ElementsAPI = Awaited<typeof elementsAPIPromise>
