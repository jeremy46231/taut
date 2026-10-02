// Makes Slackbot custom responses be from Slackbot again

import { TautPlugin } from '$taut'

export default class BringBackSlackbot extends TautPlugin<
  typeof BringBackSlackbot
> {
  static readonly id = 'BringBackSlackbot'
  static readonly pluginName = 'Bring Back Slackbot'
  static readonly description =
    'Makes Slackbot custom responses be from Slackbot again'
  static readonly authors = ['jeremy'] as const
  static readonly category = 'messages'
  static readonly defaultConfig = {
    enabled: true,
  }

  start(): void {
    this.api.experiments.set('reskin_custom_responses', 'off')
    this.log('Started')
  }
}
