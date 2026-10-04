// The band above the prompt and the /sdlc-sensors pane: what the sensors saw, at zero tokens.
import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'
import type { Band, SensorBand, Story, StepInfo } from '../types'

export const SOFT_CONTEXT = 120_000
export const HARD_CONTEXT = 150_000
export const PANE_ID = 'sdlc-sensors'
export const STORY_PANE = 'sdlc-story'
export const METRICS_PANE = 'sdlc-metrics'
export const band = atom({ plugin: 'sdlc', key: 'band' } as const, null as Band | null)
export const paneText = atom({ plugin: 'sdlc', key: 'paneText' } as const, '')
export const metricsText = atom({ plugin: 'sdlc', key: 'metricsText' } as const, '')
const isHidden = atom({ plugin: 'sdlc', key: 'isHidden' } as const, false)

export function sensorText(s: SensorBand | null): string {
  if (!s) return ''
  const extras = [s.unresolved ? `unresolved ${s.unresolved}` : '', s.knownRed ? `known-red ${s.knownRed}` : '', s.waivers ? `waivers ${s.waivers}` : ''].filter(Boolean)
  const failing = Object.entries(s.bySensor).map(([k, v]) => `${k}(${v})`).join(' ')
  return ` · ${s.blocks ? `✗ ${failing}` : 'sensors ✓'}${extras.length ? ' · ' + extras.join(' · ') : ''}`
}

const kilo = (n = 0): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const usd = (v?: number): string => { const n = v ?? 0; return `$${n.toLocaleString('en-US', { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 })}` }
const cap = (n: number): string => (Number.isInteger(n) ? `$${n}` : usd(n))

export function storyText(s: Story | null): string {
  if (!s) return ''
  const loop = s.cap ? ` ⟲${s.round}/${s.cap}` : ''
  const state = s.verdict === 'blocked' ? ' ⛔' : s.verdict === 'human' ? ' ⏸ gate' : s.verdict === 'ready' ? ' ✓ ready' : ''
  return ` · ${s.node ?? 'done'}${loop}${state} · ${kilo(s.tokens)} tok · ${usd(s.usd)} · value ≈ ${usd(s.valueUsd)} (est.)`
}

export function storyPaneText(s: Story | null, step: StepInfo | null = null): string {
  if (!s) return 'no active story'
  const note = step?.verdict === 'blocked' ? [`blocked: ${step.reason}`, ''] : step?.verdict === 'human' ? [`waiting at gate: ${step.command}`, ''] : []
  const nodes = Object.entries(s.usdByNode ?? {}).map(([n, u]) => `  ${n.padEnd(10)} ${usd(u)}`).join('\n') || '  no turns logged yet'
  const budget = Object.entries(s.budgetByNode ?? {}).map(([n, b]) => `${n} ${usd(b.spent)}/${cap(b.cap)}`).join(' · ')
  return [
    ...note,
    `${s.slug} · ${s.node ?? 'done'} · ${s.verdict}${s.cap ? ` · round ${s.round}/${s.cap}` : ''}`,
    '', 'cost by node', nodes,
    ...(budget ? ['', `budget ${budget}`] : []),
    '', `tokens ${(s.tokens ?? 0).toLocaleString('en-US')} · cost ${usd(s.usd)} · value ≈ ${usd(s.valueUsd)} (${s.valueHours ?? 0} h, estimate) · value/cost ${s.usd ? ((s.valueUsd ?? 0) / s.usd).toFixed(1) : '–'}×`,
    `auto-approved ${s.autoApproved ?? 0} · escalations ${s.escalations ?? 0} · test levels ${s.levels || '–'} · sensors ${s.sensors ?? '–'}`,
  ].join('\n')
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
        <Text dimColor>sdlc · {current.change ?? 'no active change'}{current.story ? storyText(current.story) : current.stage ? ` · ${current.stage}` : ''} · </Text>
        <Text color={color} dimColor={!color}>ctx {k}k</Text>
        <Text dimColor> · ${current.sessionUsd.toFixed(2)} session{current.contextTokens >= HARD_CONTEXT ? ' · run /compact' : ''}</Text>
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

  on('ui.render', { component: 'Pane', requestId: STORY_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const current = await read($, band)
    return (
      <Box flexDirection="column">
        <Text>{storyPaneText(current?.story ?? null, current?.step ?? null)}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: METRICS_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>{(await read($, metricsText)) || 'no metrics yet'}</Text>
      </Box>
    )
  })
}
