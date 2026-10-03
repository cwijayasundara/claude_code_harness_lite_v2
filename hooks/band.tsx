// The band above the prompt and the /sdlc-sensors pane: what the sensors saw, at zero tokens.
import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'
import type { Band, SensorBand } from '../types'

export const SOFT_CONTEXT = 120_000
export const HARD_CONTEXT = 150_000
export const PANE_ID = 'sdlc-sensors'
export const band = atom({ plugin: 'sdlc', key: 'band' } as const, null as Band | null)
export const paneText = atom({ plugin: 'sdlc', key: 'paneText' } as const, '')
const isHidden = atom({ plugin: 'sdlc', key: 'isHidden' } as const, false)

export function sensorText(s: SensorBand | null): string {
  if (!s) return ''
  const extras = [s.unresolved ? `unresolved ${s.unresolved}` : '', s.knownRed ? `known-red ${s.knownRed}` : '', s.waivers ? `waivers ${s.waivers}` : ''].filter(Boolean)
  const failing = Object.entries(s.bySensor).map(([k, v]) => `${k}(${v})`).join(' ')
  return ` · ${s.blocks ? `✗ ${failing}` : 'sensors ✓'}${extras.length ? ' · ' + extras.join(' · ') : ''}`
}

export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, band)
    if (e.props.hasSurvey || current === null || (await read($, isHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const k = Math.round(current.contextTokens / 1000)
    const color = current.contextTokens >= HARD_CONTEXT ? 'red' : current.contextTokens >= SOFT_CONTEXT ? 'yellow' : undefined
    const sensorColor = current.sensors?.blocks || current.sensors?.unresolved ? 'red' : undefined
    return (
      <Box>
        <Text dimColor>sdlc · {current.change ?? 'no active change'}{current.stage ? ` · ${current.stage}` : ''} · </Text>
        <Text color={color} dimColor={!color}>ctx {k}k</Text>
        <Text dimColor> · ${current.sessionUsd.toFixed(2)} session{current.contextTokens >= HARD_CONTEXT ? ' · run /sdlc:handoff' : ''}</Text>
        <Text color={sensorColor} dimColor={!sensorColor}>{sensorText(current.sensors)} </Text>
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>{(await read($, paneText)) || 'no sensor results yet'}</Text>
      </Box>
    )
  })
}
