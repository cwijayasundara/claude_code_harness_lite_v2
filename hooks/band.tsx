// The band above the prompt and the /rig-sensors pane: what the sensors saw, at zero tokens.
import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'
import type { Band, SensorBand, Story, StepInfo, FlowStep } from '../types'
import { mod, sdlcArgv } from './shared'

export const SOFT_CONTEXT = 120_000
export const HARD_CONTEXT = 150_000
export const PANE_ID = 'rig-sensors'
export const STORY_PANE = 'rig-story'
export const METRICS_PANE = 'rig-metrics'
export const band = atom({ plugin: 'rig', key: 'band' } as const, null as Band | null)
export const paneText = atom({ plugin: 'rig', key: 'paneText' } as const, '')
export const metricsText = atom({ plugin: 'rig', key: 'metricsText' } as const, '')
const isHidden = atom({ plugin: 'rig', key: 'isHidden' } as const, false)

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
  return ` · ${s.node ?? 'done'}${loop}${state} · ${kilo(s.tokens)} tok · ${usd(s.usd)}`
}

const MARK = { done: '✓', gate: '⏸', current: '▶', todo: ' ' } as const
export const flowGuide = (flow: FlowStep[] | undefined): string[] =>
  flow?.length ? ['where you are', ...flow.map(f => `  ${MARK[f.state]} ${f.command.padEnd(34)} ${f.why}`), ''] : []

export function storyPaneText(s: Story | null, step: StepInfo | null = null, flow?: FlowStep[]): string {
  if (!s) return [...flowGuide(flow), 'no active story'].join('\n')
  const note = step?.verdict === 'blocked' ? [`blocked: ${step.reason}`, ''] : step?.verdict === 'human' ? [`waiting at gate: ${step.command}`, ''] : []
  const nodes = Object.entries(s.usdByNode ?? {}).map(([n, u]) => `  ${n.padEnd(10)} ${usd(u)}`).join('\n') || '  no turns logged yet'
  const budget = Object.entries(s.budgetByNode ?? {}).map(([n, b]) => `${n} ${usd(b.spent)}/${cap(b.cap)}`).join(' · ')
  return [
    ...flowGuide(flow),
    ...note,
    `${s.slug} · ${s.node ?? 'done'} · ${s.verdict}${s.cap ? ` · round ${s.round}/${s.cap}` : ''}`,
    '', 'cost by node', nodes,
    ...(budget ? ['', `budget ${budget}`] : []),
    '', `tokens ${(s.tokens ?? 0).toLocaleString('en-US')} · cost ${usd(s.usd)}`,
    `auto-approved ${s.autoApproved ?? 0} · escalations ${s.escalations ?? 0} · test levels ${s.levels || '–'} · sensors ${s.sensors ?? '–'}`,
  ].join('\n')
}

export function registerBand(on: On): void {
  on('command.run', { command: 'rig-sensors' }, async $ => {
    const r = await $.process.run(sdlcArgv($.plugin.root, 'sensors'))
    await update($, paneText, () => (r.stdout || r.stderr).trim())
    await $.ui.open({ id: PANE_ID, title: 'sdlc sensors' })
    return { text: (r.stdout || r.stderr).trim() }
  })

  on('command.run', { command: 'rig-metrics-pane' }, async $ => {
    const r = await $.process.run(sdlcArgv($.plugin.root, 'metrics'))
    await update($, metricsText, () => (r.stdout || r.stderr).trim())
    await $.ui.open({ id: METRICS_PANE, title: 'sdlc metrics' })
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, band)
    if (mod.aside || e.props.hasSurvey || current === null || (await read($, isHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const k = Math.round(current.contextTokens / 1000)
    const color = current.contextTokens >= HARD_CONTEXT ? 'red' : current.contextTokens >= SOFT_CONTEXT ? 'yellow' : undefined
    const sensorColor = current.sensors?.blocks || current.sensors?.unresolved ? 'red' : undefined
    return (
      <Box flexDirection="column">
        {current.flow?.length ? <Box>{current.flow.map((f, i) => <Text key={f.label + i} bold={f.state === 'current' || f.state === 'gate'} inverse={f.state !== 'done' && f.state !== 'todo'} dimColor={f.state === 'done' || f.state === 'todo'} color={f.state === 'done' ? 'green' : f.state === 'gate' ? 'yellow' : undefined}>{`${i ? ' → ' : ''}${f.state === 'current' || f.state === 'gate' ? ` ${f.label}${f.state === 'gate' ? ' ⏸' : ''} ` : f.state === 'done' ? f.label + ' ✓' : f.label}`}</Text>)}</Box> : null}
      <Box>
        <Text dimColor>sdlc · {current.change ?? 'no active change'}{current.story ? storyText(current.story) : current.stage ? ` · ${current.stage}` : ''} · </Text>
        <Text color={color} dimColor={!color}>ctx {k}k</Text>
        <Text dimColor> · ${current.sessionUsd.toFixed(2)} session{current.contextTokens >= HARD_CONTEXT ? ' · run /compact' : ''}</Text>
        <Text color={sensorColor} dimColor={!sensorColor}>{sensorText(current.sensors)} </Text>
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
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
        <Text>{storyPaneText(current?.story ?? null, current?.step ?? null, current?.flow)}</Text>
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
