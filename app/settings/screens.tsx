// Taut Settings: the Appearance, Advanced and About screens

import type { TautInstallType } from '../../shared/TautBridge'
import type { NormalizedBridge } from '../bridgeCompat'
import { tautVersion } from '../bundledData'
import { checkConfig, configText } from '../configStore'
import { updateStatus } from '../loaderUpdate'
import { reloadInSafeMode, reloadWithoutSafeMode } from '../safeMode'
import { workspace } from '../slack/workspace'
import { UpdateList } from './changelog'
import {
  authorsMrkdwn,
  ConfigCheckbox,
  DocumentEditor,
  elements,
  errorMessage,
  ImportControls,
  loaderName,
  type SettingsProps,
  SlackText,
  SubScreen,
  useConfigText,
} from './common'
import { configSchema } from './configSchema'

export const SCREENS_CSS = `
  .taut-settings__credits {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
`

/** how the desktop app was installed */
const INSTALL_NAMES: Record<TautInstallType, string | null> = {
  nsis: 'installer',
  homebrew: 'Homebrew',
  mac: 'app download',
  'mac-adhoc': 'unsigned build',
  'mac-readonly': 'not in Applications',
  appimage: 'AppImage',
  nix: 'Nix',
  deb: 'deb package',
  apt: 'apt repository',
  rpm: 'rpm package',
  dnf: 'dnf repository',
  pacman: 'pacman package',
  embedded: null,
  temporary: 'temporary copy',
  dev: 'dev build',
  unknown: null,
}

function storageNote(bridge: NormalizedBridge, file: string): string {
  const display =
    bridge.PATHS?.display[file === 'user.css' ? 'userCss' : 'config']
  return display
    ? `Saved to \`${display}\`.`
    : `Saved in ${loaderName(bridge.loader, { inSentence: true })} storage.`
}

export function AppearanceScreen({
  pluginManager,
  configStore,
  onBack,
}: SettingsProps & { onBack: () => void }) {
  const css = React.useSyncExternalStore(
    (onChange) => configStore.onUserCssChange(onChange),
    () => configStore.getUserCssText()
  )
  return (
    <SubScreen title="Appearance" onBack={onBack}>
      <elements.FieldSet>
        <elements.Legend>Custom CSS</elements.Legend>
        <div className="taut-settings__muted taut-settings__field">
          <elements.MrkdwnElement
            text={storageNote(pluginManager.bridge, 'user.css')}
          />
        </div>
        <DocumentEditor
          language="css"
          value={css}
          height={420}
          saveLabel="Save user.css"
          save={async (text) => {
            await configStore.updateUserCssText(text)
            return configStore.getUserCssText() === text
              ? null
              : 'Failed to save user.css'
          }}
        />
      </elements.FieldSet>
    </SubScreen>
  )
}

export function AdvancedScreen({
  pluginManager,
  configStore,
  onBack,
  onOpenPlugin,
}: SettingsProps & { onBack: () => void; onOpenPlugin: (id: string) => void }) {
  const bridge = pluginManager.bridge
  const text = useConfigText(configStore)
  const parseError = configStore.getParseError()
  const updates = updateStatus.use()?.items ?? []
  const plugins = pluginManager.pluginInfoStore.use()
  const schema = React.useMemo(() => configSchema(plugins), [plugins])

  const source = [
    `Taut v${tautVersion}`,
    `${loaderName(bridge.loader)} v${bridge.loaderVersion}`,
    bridge.install ? INSTALL_NAMES[bridge.install.type] : null,
    bridge.embedded ? 'embedded copy' : null,
    `bridge v${bridge.bridgeVersion}`,
  ]
    .filter(Boolean)
    .join(' · ')

  // how to change the app source
  const appSource: Record<NormalizedBridge['loader'], string> = {
    electron: 'Taut menu > Change App Source…',
    userscript: 'Tampermonkey menu > Taut Options',
    'chrome-extension': 'Manage extension > Extension options',
    'firefox-extension': 'Manage Extension > Preferences',
  }

  return (
    <SubScreen title="Advanced" onBack={onBack}>
      <elements.FieldSet>
        <elements.Legend>Installation</elements.Legend>
        <p className="taut-settings__muted" style={{ margin: 0 }}>
          {source}
        </p>
        <UpdateList items={updates} />
        {bridge.PATHS && (
          <elements.MrkdwnElement
            text={`Config directory: \`${bridge.PATHS.display.tautDir}\``}
          />
        )}
        <p className="taut-settings__small">
          Change where Taut loads from: {appSource[bridge.loader]}
        </p>
      </elements.FieldSet>

      <elements.FieldSet>
        <elements.Legend>Safe mode</elements.Legend>
        <p className="taut-settings__muted" style={{ marginTop: 0 }}>
          {pluginManager.safeMode
            ? 'Plugins and custom CSS are off until you reload.'
            : 'Reload once with plugins and custom CSS off.'}
        </p>
        <elements.Button
          type="outline"
          size="small"
          onClick={
            pluginManager.safeMode ? reloadWithoutSafeMode : reloadInSafeMode
          }
        >
          {pluginManager.safeMode ? 'Leave safe mode' : 'Reload in safe mode'}
        </elements.Button>
      </elements.FieldSet>

      <elements.FieldSet>
        <elements.Legend>What's new</elements.Legend>
        <ConfigCheckbox
          configStore={configStore}
          path={['whatsNewButton']}
          defaultValue={true}
          label="Show the What's new button in the top bar"
        />
      </elements.FieldSet>

      <elements.FieldSet>
        <elements.Legend>Usage statistics</elements.Legend>
        <ConfigCheckbox
          configStore={configStore}
          path={['telemetry']}
          defaultValue={true}
          label="Send a daily usage ping"
          subtext="Used only for counting installs for analytics. Nothing about what you do in Slack, and will not be used for any other purpose."
        />
      </elements.FieldSet>

      <elements.FieldSet>
        <elements.Legend>Install a plugin</elements.Legend>
        {pluginManager.supportsUserPlugins ? (
          <>
            <p className="taut-settings__muted" style={{ marginTop: 0 }}>
              Add a pre-built plugin from a .js file or a link. Only install
              code you trust! Plugins can do anything you can do in Slack.
            </p>
            <ImportControls
              pluginManager={pluginManager}
              onDone={onOpenPlugin}
            />
          </>
        ) : (
          <p className="taut-settings__muted" style={{ marginTop: 0 }}>
            Your {loaderName(bridge.loader, { inSentence: true })} is too old to
            install plugins. Update it to add your own.
          </p>
        )}
      </elements.FieldSet>

      <elements.FieldSet>
        <elements.Legend>config.json</elements.Legend>
        <div className="taut-settings__muted taut-settings__field">
          <elements.MrkdwnElement text={storageNote(bridge, 'config.json')} />
        </div>
        {parseError && (
          <elements.InlineAlert>
            Can't read config.json: {parseError}
          </elements.InlineAlert>
        )}
        <DocumentEditor
          language="json"
          schema={schema}
          value={text}
          height={420}
          saveLabel="Save config.json"
          save={async (next) => {
            let parsed: unknown
            try {
              parsed = JSON.parse(next)
            } catch (err) {
              return `Not saved: ${errorMessage(err)}`
            }
            const checked = checkConfig(parsed)
            if ('error' in checked) return `Not saved: ${checked.error}`
            return (await configStore.updateConfigText(
              configText(checked.config)
            ))
              ? null
              : 'Failed to save config.json'
          }}
        />
      </elements.FieldSet>
    </SubScreen>
  )
}

export function AboutScreen({
  pluginManager,
  onBack,
}: SettingsProps & { onBack: () => void }) {
  const plugins = pluginManager.pluginInfoStore
    .use()
    .filter((plugin) => plugin.runsHere)
  const hackClub = workspace.useIsHackClub()
  return (
    <SubScreen title="About" onBack={onBack}>
      <elements.FieldSet>
        <elements.Legend>Taut v{tautVersion}</elements.Legend>
        <SlackText text="A client mod for Slack, made by <@U06UYA5GMB5>. Come say hi in <#C0A057686SF>, and find the code on <https://github.com/jeremy46231/taut|GitHub> (GPLv3 or later)." />
      </elements.FieldSet>
      <elements.FieldSet>
        <elements.Legend>Plugins</elements.Legend>
        <ul className="taut-settings__credits">
          {plugins.map((plugin) => (
            <li key={plugin.id}>
              <elements.MrkdwnElement
                text={`*${plugin.name}* by ${authorsMrkdwn(plugin.authors, hackClub)}`}
              />
            </li>
          ))}
        </ul>
      </elements.FieldSet>
    </SubScreen>
  )
}
