import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

export function findSlackAsar(): string {
  const candidates: string[] = []
  const home = os.homedir()

  switch (process.platform) {
    case 'darwin':
      candidates.push(
        '/Applications/Slack.app/Contents/Resources/app.asar',
        join(home, 'Applications/Slack.app/Contents/Resources/app.asar')
      )
      break

    case 'win32': {
      // Classic NSIS installer: %LOCALAPPDATA%\slack\app-x.y.z\resources\app.asar
      const localAppData =
        process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
      const slackDir = join(localAppData, 'slack')
      if (existsSync(slackDir)) {
        for (const v of readdirSync(slackDir)
          .filter((d) => d.startsWith('app-'))
          .sort()
          .reverse()) {
          candidates.push(join(slackDir, v, 'resources', 'app.asar'))
        }
      }
      // Microsoft Store install: %ProgramFiles%\WindowsApps\com.tinyspeck.slackdesktop_*
      const programFiles = process.env.ProgramFiles ?? process.env.ProgramW6432
      if (programFiles) {
        const windowsApps = join(programFiles, 'WindowsApps')
        try {
          for (const pkg of readdirSync(windowsApps)
            .filter((d) => d.startsWith('com.tinyspeck.slackdesktop_'))
            .sort()
            .reverse()) {
            candidates.push(
              join(windowsApps, pkg, 'app', 'resources', 'app.asar')
            )
          }
        } catch {}
      }
      break
    }

    case 'linux':
      candidates.push(
        '/usr/lib/slack/resources/app.asar',
        '/usr/share/slack/resources/app.asar',
        '/opt/slack/resources/app.asar',
        join(home, '.local/share/slack/resources/app.asar'),
        '/var/lib/flatpak/app/com.slack.Slack/current/active/files/extra/resources/app.asar',
        join(
          home,
          '.local/share/flatpak/app/com.slack.Slack/current/active/files/extra/resources/app.asar'
        ),
        '/snap/slack/current/usr/lib/slack/resources/app.asar'
      )
      break
  }

  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('Slack installation not found')
  return found
}
