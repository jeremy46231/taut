// Makes Slack links at the start of your messages invisible, like a forwarded message

import { type RichTextElement, TautPlugin } from '$taut'

export default class InvisibleForward extends TautPlugin<
  typeof InvisibleForward
> {
  static readonly id = 'InvisibleForward'
  static readonly pluginName = 'Invisible Forward'
  static readonly category = 'messageBox'
  static readonly defaultConfig = {
    enabled: false,
  }
  static readonly description =
    'Makes Slack links at the start of your messages invisible, like a forwarded message'
  static readonly authors = ['jeremy', 'cyril'] as const

  start() {
    this.api.onMessageSendBlocks((blocks) =>
      this.api.blocks.mapRichTextSections(blocks, (elements, run) =>
        run.index === 0 &&
        run.container === 'rich_text_section' &&
        run.parent === 'rich_text'
          ? this.hideLeadingLinks(elements)
          : elements
      )
    )
    this.log('Started')
  }

  protected hideLeadingLinks(elements: RichTextElement[]): RichTextElement[] {
    const hidden: string[] = []
    let i = 0
    for (; i < elements.length; i++) {
      const element = elements[i]
      if (element.type === 'link' && !element.style) {
        const url = String(element.url ?? '')
        // markdown mode's links arrive with shortened text marked truncated
        const bare =
          !element.text || element.text === url || !!element.truncated
        // a link written as "." is hidden even if it isn't a Slack URL
        if ((bare && this.isSlackUrl(url)) || element.text === '.') {
          hidden.push(url)
          continue
        }
        break
      }
      if (
        element.type === 'text' &&
        !element.style &&
        element.text?.trim() === ''
      ) {
        continue
      }
      break
    }
    if (hidden.length === 0) return elements

    const rest = elements.slice(i)
    const first = rest[0]
    if (first?.type === 'text' && typeof first.text === 'string') {
      const trimmed = first.text.trimStart()
      if (trimmed) rest[0] = { ...first, text: trimmed }
      else rest.shift()
    }
    return [
      ...hidden.map((url) => ({ type: 'link', url, text: '\u2060' })),
      ...rest,
    ]
  }

  protected isSlackUrl(url: string): boolean {
    try {
      const parsedUrl = new URL(url)
      if (parsedUrl.hostname === 'app.slack.com') return true
      if (parsedUrl.hostname === 'files.slack.com') return true
      if (
        parsedUrl.hostname === 'slack.com' ||
        parsedUrl.hostname.endsWith('.slack.com')
      ) {
        if (parsedUrl.pathname.startsWith('/archives/')) return true
        if (parsedUrl.pathname.startsWith('/files/')) return true
        if (parsedUrl.pathname.startsWith('/docs/')) return true
        if (parsedUrl.pathname.startsWith('/team/')) return true
        if (parsedUrl.pathname.startsWith('/shortcuts/')) return true
        if (parsedUrl.pathname.startsWith('/huddle/')) return true
      }
    } catch {}
    return false
  }
}
