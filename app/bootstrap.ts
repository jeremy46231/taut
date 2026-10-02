// Taut Bootstrap: wires up the bridge and config store, then starts plugins

import type { BlobStore } from '../shared/TautBridge'
import { applyPendingSwitch } from './api/accountSwitcher'
import { setStyle } from './api/css'
import { installResizeGate } from './api/resize'
import { Telemetry } from './api/telemetry'
import type { NormalizedBridge } from './bridgeCompat'
import { bundledPlugins } from './bundledData'
// remove once users have moved to the pinned chrome extension
import { startChromeMigrationMirror } from './chromeMigration'
import { ConfigStore } from './configStore'
import { startUpdateCheck } from './loaderUpdate'
import { PluginManager } from './pluginManager'
import { consumeSafeMode } from './safeMode'
import { addSettingsTab } from './settings'
import {
  applySavedExperiments,
  switchToLiveExperiments,
} from './slack/experiments'
import { addPatchTargets, patchTargets } from './slack/react'
import { WhatsNew } from './whatsNew'
import { addWhatsNewButton } from './whatsNewButton'

const global = globalThis as any

/** keeps the component names that have ever been patched across sessions */
async function syncPatchTargets(blob: BlobStore) {
  patchTargets.subscribe(() => {
    blob.write('names', JSON.stringify([...patchTargets.get()]))
  })
  try {
    const raw = await blob.read('names')
    if (raw) addPatchTargets(JSON.parse(raw))
  } catch (err) {
    console.error('[Taut] Failed to load patch targets:', err)
  }
}

export async function bootstrap(bridge: NormalizedBridge): Promise<void> {
  console.log('[Taut] Bootstrap starting...')

  // must stay before any await
  applyPendingSwitch()
  installResizeGate()

  const safeMode = consumeSafeMode()
  if (safeMode) console.warn('[Taut] Safe mode: plugins and user CSS are off')
  // slack reads many experiments while booting, before plugins start
  else applySavedExperiments()

  await bridge.start()
  if (!safeMode) syncPatchTargets(bridge.blobStore('patch_targets'))

  const configStore = new ConfigStore(bridge)
  await configStore.init()
  console.log('[Taut] ConfigStore initialized', configStore)
  global.configStore = configStore

  const whatsNew = new WhatsNew(bridge)
  whatsNew.init(Object.keys(configStore.getConfig().plugins).length === 0)

  if (!safeMode) {
    setStyle(configStore.getUserCssText(), 'user')
    configStore.onUserCssChange((css) => setStyle(css, 'user'))
  }

  const pluginManager = new PluginManager(bridge, configStore, safeMode)
  global.__tautPluginManager = pluginManager
  addWhatsNewButton({ whatsNew, pluginManager, configStore })

  // before user plugins, so a built-in plugin keeps its id when a user plugin claims it too
  await Promise.all(
    Object.values(bundledPlugins).map((code) =>
      pluginManager.loadPluginCode(code, 'bundled')
    )
  )

  const userPlugins = bridge.userPlugins
  const userPluginGenerations = new Map<string, number>()
  userPlugins.onChange((id, code) => {
    userPluginGenerations.set(id, (userPluginGenerations.get(id) ?? 0) + 1)
    pluginManager.applyUserPluginChange(id, code)
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

  // plugins loaded, so stop using the cached experiment settings
  if (!safeMode) switchToLiveExperiments()

  await configStore.removeDefaults(
    new Map(
      [...pluginManager.plugins].flatMap(([id, { PluginClass }]) =>
        PluginClass ? [[id, PluginClass.defaultConfig]] : []
      )
    )
  )

  await addSettingsTab(pluginManager, configStore, whatsNew)
  new Telemetry(bridge, configStore).start()
  startUpdateCheck(bridge)
  // remove once users have moved to the pinned chrome extension
  startChromeMigrationMirror(bridge, pluginManager)

  console.log('[Taut] Taut initialized')
}
