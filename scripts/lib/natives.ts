import path from 'node:path'
import { DESKTOP } from './paths.ts'

export interface SlackNativeModule {
  package: string
  version: string
  file: string
  slackPackage?: string
  /** the version of `slackPackage` this pin was checked against, when slack ships a fork */
  slackVersion?: string
}

export const SLACK_NATIVE_MODULES: SlackNativeModule[] = [
  {
    // slack's fork only adds ignoreAllEvents, that's fine
    package: 'native-keymap',
    version: '3.3.9',
    file: 'keymapping.node',
    slackPackage: '@tinyspeck/native-keymap',
    slackVersion: '2.2.3',
  },
  {
    package: 'file-handler-info',
    version: '0.2.1',
    file: 'file_handler_info.node',
  },
  {
    package: 'electron-native-auth',
    version: '0.1.1',
    file: 'electron_native_auth.node',
  },
]

export const nativesDir = (platformKey: string) =>
  path.join(DESKTOP, 'native', platformKey)
