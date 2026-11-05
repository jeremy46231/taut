// Makes Slack not copy that stupid little timestamp

import { TautPlugin } from '$taut'

export default class IgnoreTime extends TautPlugin<typeof IgnoreTime> {
  static readonly id = 'IgnoreTime'
  static readonly pluginName = 'Ignore Time'
  static readonly description =
    'Makes Slack not copy that stupid little timestamp'
  static readonly authors = ['izie'] as const
  static readonly category = 'messages'
  static readonly defaultConfig = {
    enabled: true,
  }

  start(): void {
    this.api.setStyle(
      '.c-timestamp__label { -webkit-user-select: none; user-select: none; }'
    )
  }
}
