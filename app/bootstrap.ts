// Taut Bootstrap
// Wires up the backend, config store, and starts plugins

import type { BlobStore } from '../shared/TautBridge'
import { applyPendingSwitch } from './api/accountSwitcher'
import { setStyle } from './api/css'
import { installResizeGate } from './api/resize'
import { Telemetry } from './api/telemetry'
import type { NormalizedBridge } from './bridgeCompat'
import { bundledPlugins } from './bundledData'
import { ConfigStore } from './configStore'
import { PluginManager } from './pluginManager'
import { addSettingsTab } from './settings'
import { addPatchTargets, patchTargets } from './slack/react'

const global = globalThis as any

/** Keeps the component names that have ever been patched across sessions */
async function syncPatchTargets(blob: BlobStore) {
  patchTargets.subscribe(() => {
    void blob.write('names', JSON.stringify([...patchTargets.get()]))
  })
  try {
    const raw = await blob.read('names')
    if (raw) addPatchTargets(JSON.parse(raw))
  } catch (err) {
    console.error('[Taut] Failed to load patch targets:', err)
  }
}

/**
 * Main entry point for Taut initialization.
 */
export async function bootstrap(bridge: NormalizedBridge): Promise<void> {
  console.log('[Taut] Bootstrap starting...')

  // must stay before any await
  applyPendingSwitch()
  installResizeGate()

  await bridge.start()
  void syncPatchTargets(bridge.blobStore('patch_targets'))

  const configStore = new ConfigStore(bridge)
  await configStore.init()
  console.log('[Taut] ConfigStore initialized', configStore)
  global.configStore = configStore

  setStyle(configStore.getUserCssText(), 'user')
  configStore.onUserCssChange((css) => setStyle(css, 'user'))

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
  new Telemetry(bridge, configStore).start()

  console.log('[Taut] Taut initialized')
}
