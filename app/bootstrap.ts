// Taut Bootstrap
// Wires up the backend, config store, and starts plugins

import { applyPendingSwitch } from './api/accountSwitcher'
import { setStyle } from './api/css'
import type { NormalizedBridge } from './bridgeCompat'
import { bundledPlugins } from './bundledData'
import { ConfigStore } from './configStore'
import { PluginManager } from './pluginManager'
import { addSettingsTab } from './settings'

const global = globalThis as any

/**
 * Main entry point for Taut initialization.
 */
export async function bootstrap(bridge: NormalizedBridge): Promise<void> {
  console.log('[Taut] Bootstrap starting...')

  // must stay before any await
  applyPendingSwitch()

  await bridge.start()

  const configStore = new ConfigStore(bridge)
  await configStore.init()
  console.log('[Taut] ConfigStore initialized', configStore)
  global.configStore = configStore

  setStyle('user', configStore.getUserCssText())
  configStore.onUserCssChange((css) => setStyle('user', css))

  // Initialize plugins
  const pluginManager = new PluginManager(bridge, configStore)
  global.__tautPluginManager = pluginManager

  // Load all bundled plugins first
  await Promise.all(
    Object.values(bundledPlugins).map((code) =>
      pluginManager.loadPluginCode(code, 'bundled')
    )
  )

  // Load user plugins and keep in sync
  const userPlugins = bridge.userPlugins
  const userPluginGenerations = new Map<string, number>()
  userPlugins.onChange((id, code) => {
    userPluginGenerations.set(id, (userPluginGenerations.get(id) ?? 0) + 1)
    void pluginManager.applyUserPluginChange(id, code)
  })
  try {
    const ids = await userPlugins.list()
    await Promise.all(
      ids.map(async (id) => {
        const generation = userPluginGenerations.get(id) ?? 0
        const code = await userPlugins.read(id)
        if (code && generation === (userPluginGenerations.get(id) ?? 0)) {
          await pluginManager.applyUserPluginChange(id, code)
        }
      })
    )
  } catch (err) {
    console.error('[Taut] Failed to load user plugins:', err)
  }

  await addSettingsTab(pluginManager, configStore)

  console.log('[Taut] Taut initialized')
}
