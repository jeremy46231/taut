// Taut Settings: JSON schemas for the config.json and plugin block editors (Monaco validation, completion and hovers)

import type { DefaultConfig } from '../../shared/Plugin'
import { type DefaultEntry, fileEntries } from '../pluginConfig'
import type { PluginInfo } from '../pluginManager'
import { plainMrkdwn } from './common'

type Schema = Record<string, unknown>

// mirrors checkKind in app/pluginConfig.ts, minus what a schema can't represent (css colors, `check`)
function valueSchema(entry: DefaultEntry): Schema {
  const { kind, value } = entry
  switch (kind.type) {
    case 'boolean':
      return { type: 'boolean' }
    // min and max only bound the settings form
    case 'number':
      return { type: 'number' }
    case 'string':
    case 'color':
    case 'secret':
      return { type: 'string' }
    case 'select':
      return {
        enum: kind.options.map((option) => option.value),
        markdownEnumDescriptions: kind.options.map((option) => option.label),
      }
    case 'list':
      return { type: 'array', items: { type: 'string' } }
    case 'json':
      if (Array.isArray(value)) return { type: 'array' }
      if (value !== null && typeof value === 'object') return { type: 'object' }
      return {}
  }
}

function optionSchema(entry: DefaultEntry): Schema {
  const lines = [`**${entry.label}**`]
  if (entry.comment) lines.push(plainMrkdwn(entry.comment))
  if (entry.kind.type === 'select') {
    lines.push(
      `One of ${entry.kind.options.map((option) => `\`${JSON.stringify(option.value)}\``).join(', ')}`
    )
  }
  return {
    ...valueSchema(entry),
    default: entry.value,
    markdownDescription: lines.join('\n\n'),
  }
}

/** one plugin's block, `enabled` plus its options */
export function pluginSchema(defaults: DefaultConfig): Schema {
  return {
    type: 'object',
    properties: Object.fromEntries(
      fileEntries(defaults).map((entry) => [entry.key, optionSchema(entry)])
    ),
    additionalProperties: false,
  }
}

/** all of config.json, plugins not loaded here are still allowed */
export function configSchema(plugins: PluginInfo): Schema {
  return {
    type: 'object',
    properties: {
      plugins: {
        type: 'object',
        properties: Object.fromEntries(
          plugins.flatMap(({ id, name, description, defaultConfig }) =>
            defaultConfig
              ? [
                  [
                    id,
                    {
                      ...pluginSchema(defaultConfig),
                      markdownDescription: `**${name}**\n\n${plainMrkdwn(description)}`,
                    },
                  ],
                ]
              : []
          )
        ),
        additionalProperties: { type: 'object' },
      },
      telemetry: {
        type: 'boolean',
        default: true,
        markdownDescription: '**Send a daily usage ping**',
      },
      whatsNewButton: {
        type: 'boolean',
        default: true,
        markdownDescription: "**Show the What's new button in the top bar**",
      },
    },
    additionalProperties: false,
  }
}
