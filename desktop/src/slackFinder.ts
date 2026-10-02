import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { slackNativeArches } from './nativeModules.js'
import { slackArch } from './slackDownload.js'

// a non-elevated process can't list WindowsApps but can read an exact path in it, so get msix Slack's full package name from the registry
function findStorePackageFullNames(prefix: string): string[] {
  const key =
    'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages'
  let output: string
  try {
    output = execFileSync('reg', ['query', key], {
      encoding: 'utf8',
      windowsHide: true,
    })
  } catch {
    return []
  }
  const versionParts = (fullName: string) =>
    (fullName.split('_')[1] ?? '').split('.').map((n) => Number(n) || 0)
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^HKEY_/i.test(line))
    .map((line) => line.slice(line.lastIndexOf('\\') + 1))
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => {
      const [va, vb] = [versionParts(a), versionParts(b)]
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        if ((vb[i] ?? 0) !== (va[i] ?? 0)) return (vb[i] ?? 0) - (va[i] ?? 0)
      }
      return 0
    })
}

/** app.asar of an officially installed Slack, if there is one */
export function findInstalledSlackAsar(): string | undefined {
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
      // classic nsis installer: %LOCALAPPDATA%\slack\app-x.y.z\resources\app.asar
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
      // msix install: %ProgramFiles%\WindowsApps\<full name>\app\resources\app.asar
      const programFiles = process.env.ProgramFiles ?? process.env.ProgramW6432
      if (programFiles) {
        for (const fullName of findStorePackageFullNames(
          'com.tinyspeck.slackdesktop_'
        )) {
          candidates.push(
            join(
              programFiles,
              'WindowsApps',
              fullName,
              'app',
              'resources',
              'app.asar'
            )
          )
        }
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

  // e.g. an x64 Slack beside an arm64 Taut, whose natives won't load
  const fits = (asar: string) =>
    slackNativeArches(dirname(asar))?.has(slackArch()) ?? true
  return candidates.find((p) => existsSync(p) && fits(p))
}
