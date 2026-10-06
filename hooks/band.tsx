// The band above the prompt and the /rig-sensors pane: what the sensors saw, at zero tokens.
import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'
import type { Band, SensorBand, Story, StepInfo, FlowStep, TurnPoint } from '../types'
import { mod, sdlcArgv, spark, spendPerTurn, subway, gauge, heat, tokenMix } from './shared'

export const SOFT_CONTEXT = 120_000
export const HARD_CONTEXT = 150_000
export const PANE_ID = 'rig-sensors'
export const STORY_PANE = 'rig-story'
export const METRICS_PANE = 'rig-metrics'
export const band = atom({ plugin: 'rig', key: 'band' } as const, null as Band | null)
export const paneText = atom({ plugin: 'rig', key: 'paneText' } as const, '')
export const metricsText = atom({ plugin: 'rig', key: 'metricsText' } as const, '')
const turns = atom({ plugin: 'rig', key: 'turns' } as const, [] as TurnPoint[])
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
    const history = await read($, turns)
    const trail = spark(spendPerTurn(history).slice(-8))
    const frac = current.contextTokens / HARD_CONTEXT
    const sensorColor = current.sensors?.blocks || current.sensors?.unresolved ? 'red' : undefined
    const story = current.story
    const line = current.flow?.length ? subway(current.flow, story, Math.max(40, e.props.bodyColumns - 2)) : null
    const hit = Math.round(tokenMix(history).hit * 100)
    // The fix-loop round rides on the current station, so the strip stays one row.
    const loop = (story && story.cap > 0 ? ` ⟲${story.round}/${story.cap}` : '') + (story?.verdict === 'blocked' ? ' ⛔' : story?.verdict === 'ready' ? ' ✓ ready' : '')
    return (
      <Box flexDirection="column">
        {line ? <Box>{line.cells.map((c, i) => {
          const here = c.state === 'current' || c.state === 'gate'
          return <Text key={c.text + i} bold={here} dimColor={c.state === 'todo'} color={here && (line.loopHot || story?.verdict === 'blocked') ? 'red' : here ? (c.state === 'gate' ? 'yellow' : 'cyan') : c.state === 'done' ? 'green' : undefined}>{`${i ? ' ─ ' : ''}${c.text}${here ? loop : ''}${c.state === 'gate' ? ' ⏸' : ''}`}</Text>
        })}</Box> : null}
        <Box>
          <Text dimColor>{current.change ?? 'no active change'}{story ? ` · ${kilo(story.tokens)} tok · ${usd(story.usd)}` : ''} · ctx </Text>
          <Text color={heat(frac)}>{gauge(frac, 8)} {kilo(current.contextTokens)}</Text>
          <Text dimColor> · {usd(current.sessionUsd)}{trail ? ` ${trail}` : ''}{history.length ? ` · cache ${hit}%` : ''}{current.contextTokens >= HARD_CONTEXT ? ' · run /compact' : ''}</Text>
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
