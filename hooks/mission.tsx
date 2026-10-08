// Mission control: /rig-map draws the SDLC as a subway line with a "you are here" marker, the fix loop as an arc,
// spend per station, and fuel gauges for context, tokens and dollars. register.ts registers the command and captures
// each turn into `turns` (a module may not hook session.start or turn.complete twice).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { Band, Status, TurnPoint } from '../types'
import { parseStatus, sdlcArgv, money, kilo, spark, gauge, heat, spendPerTurn, tokenMix, stack, subway } from './shared'
import { HARD_CONTEXT, budgetText, budgetColor } from './band'

export const MAP_PANE = 'rig-map'
const SPARK_TURNS = 24

// Same plugin and keys as band.tsx's atoms: the loader reads state refs only where they are declared.
const band = atom({ plugin: 'rig', key: 'band' } as const, null as Band | null)
const turns = atom({ plugin: 'rig', key: 'turns' } as const, [] as TurnPoint[])

const STATE_COLOR = { done: 'green', current: 'cyan', gate: 'yellow', todo: undefined } as const

async function refresh($: EngineInterface): Promise<void> {
  const status: Status | null = parseStatus((await $.process.run(sdlcArgv($.plugin.root, 'status', '--json', '--band'))).stdout)
  const change = status?.active ?? null
  const stage = status?.changes?.find(c => c.slug === change)?.next?.stage ?? (change ? 'done' : null)
  const session = await $.session.usage()
  await update($, band, () => ({ change, stage, contextTokens: session.context.tokens ?? 0, sessionUsd: session.cost?.usd ?? 0, sensors: status?.sensors ?? null, story: status?.story ?? null, step: status?.step ?? null, flow: status?.flow, budget: status?.budget ?? null }))
}

export function registerMission(on: On): void {
  on('command.run', { command: 'rig-map' }, async $ => {
    await refresh($)
    await $.ui.open({ id: MAP_PANE, title: 'sdlc mission control' })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: MAP_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const b = await read($, band)
    const history = await read($, turns)
    const columns = Math.max(40, e.props.bodyColumns)
    const story = b?.story ?? null
    if (!b?.flow?.length) return <Text dimColor>no map yet: run /rig:init, then start a change</Text>
    const line = subway(b.flow, story, columns)
    const deltas = spendPerTurn(history).slice(-SPARK_TURNS)
    const avg = deltas.length ? deltas.reduce((a, d) => a + d, 0) / deltas.length : 0
    const mix = tokenMix(history)
    const cells = stack([mix.out, mix.fresh, mix.cw, mix.cr], 36)
    const ctxFrac = b.contextTokens / HARD_CONTEXT
    const nodes = [...new Set([...Object.keys(story?.budgetByNode ?? {}), ...Object.keys(story?.usdByNode ?? {})])]
    const dear = Object.entries(story?.usdByNode ?? {}).sort((x, y) => y[1] - x[1])[0]
    return (
      <Box flexDirection="column">
        <Text bold>MISSION CONTROL · {b.change ?? 'no active change'}{story ? ` · ${story.verdict}` : ''}</Text>
        <Text> </Text>
        <Box>{line.cells.map((c, i) => <Text key={i + c.text} color={STATE_COLOR[c.state]} bold={c.state === 'current' || c.state === 'gate'} dimColor={c.state === 'todo'}>{(i ? ' ─ ' : '') + c.text}</Text>)}</Box>
        {line.marker ? <Text color="cyan">{line.marker}</Text> : null}
        {line.loop ? <Text color={line.loopHot ? 'red' : 'magenta'}>{line.loop}</Text> : null}
        <Text> </Text>
        <Text bold>SPEND BY STATION</Text>
        {nodes.length ? nodes.map(n => {
          const cap = story?.budgetByNode?.[n]?.cap ?? 0
          const spent = story?.usdByNode?.[n] ?? story?.budgetByNode?.[n]?.spent ?? 0
          return <Text key={n} color={cap ? heat(spent / cap) : undefined}>{`${n.padEnd(10)} ${gauge(cap ? spent / cap : 0, 14)} ${money(spent)}${cap ? ` / ${money(cap)}` : ''}`}</Text>
        }) : <Text dimColor>no spend on this change yet</Text>}
        <Text> </Text>
        <Text bold>FUEL</Text>
        <Text color={heat(ctxFrac)}>{`context    ${gauge(ctxFrac, 14)} ${kilo(b.contextTokens)} / ${kilo(HARD_CONTEXT)}${ctxFrac >= 1 ? '  run /compact' : ''}`}</Text>
        <Text>{`session    ${money(b.sessionUsd)}   burn ${money(avg)}/turn`}</Text>
        <Text>{`per turn   ${spark(deltas) || '–'}${deltas.length ? `  last ${money(deltas.at(-1))}` : ''}`}</Text>
        <Text> </Text>
        <Text bold>TOKEN MIX</Text>
        <Box>
          <Text color="green">{'█'.repeat(cells[0] ?? 0)}</Text><Text color="cyan">{'█'.repeat(cells[1] ?? 0)}</Text><Text color="yellow">{'▓'.repeat(cells[2] ?? 0)}</Text><Text color="magenta">{'▒'.repeat(cells[3] ?? 0)}</Text>
        </Box>
        <Text dimColor>{`out ${kilo(mix.out)} · in ${kilo(mix.fresh)} · cache write ${kilo(mix.cw)} · cache read ${kilo(mix.cr)} · hit ${Math.round(mix.hit * 100)}%`}</Text>
        <Text> </Text>
        <Text>{story ? `this change  ${kilo(story.tokens)} tok · ${money(story.usd)}${dear ? ` · dearest ${dear[0]} ${money(dear[1])}` : ''}` : 'this change  no story yet'}</Text>
        {b.budget && budgetText(b.budget) ? <Text color={budgetColor(b.budget)}>{`budget ${budgetText(b.budget).replace(/^ · /, '')}`}</Text> : null}
        <Box><Button key="refresh" label="Refresh" onPress={() => refresh($)} /></Box>
      </Box>
    )
  })
}
