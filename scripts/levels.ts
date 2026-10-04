// Test levels (spec §5.2): unit always; acceptance for tier L and greenfield; api when the plan's contracts touch an
// endpoint; integration when the plan spans more than one top-level module or a consumer repo.
import { readRuns } from './runs.ts'
import { contractsFromPlan } from './sensors.ts'
import { normCmd } from './shell.ts'
import { LEVELS, type Level, type SensorConfig } from './model.ts'
import type { Change } from './core.ts'

const ENDPOINT = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\bendpoint\b|\broute\b/i
const filesSection = (plan: string): string[] => (/^## Files\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(plan)?.[1] ?? '').split('\n').map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean)

export function requiredLevels(change: Change, planText: string, config: SensorConfig): Level[] {
  const need = new Set<Level>(['unit'])
  if (change.tier === 'L' || change.type === 'greenfield') need.add('acceptance')
  const contracts = /^## Contracts\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(planText)?.[1] ?? ''
  if (ENDPOINT.test(contracts) || contractsFromPlan(planText).some(c => ENDPOINT.test(c))) need.add('api')
  const files = filesSection(planText)
  const srcModules = new Set(files.filter(f => f.startsWith('src/')).map(f => f.split('/')[1]))
  if (srcModules.size > 1 || files.some(f => f.startsWith('../'))) need.add('integration')
  return LEVELS.filter(l => need.has(l))
}

// A repo that declares no unit command keeps v0.3 behaviour for unit: the plan's ## Verification commands stand in
// (status "plan"). Every other required level must be declared.
export function levelResults(slug: string, required: Level[], config: SensorConfig, planPassed: boolean): { level: Level; cmd: string | null; status: 'pass' | 'plan' | 'fail' | 'not-run' | 'undeclared' }[] {
  const latest = new Map<string, number>()
  for (const r of readRuns(slug)) if (!r.expectFail && !r.source) latest.set(normCmd(r.cmd), r.exit)
  return required.map(level => {
    const cmd = config.levels[level] ?? null
    if (!cmd && level === 'unit') return { level, cmd, status: planPassed ? 'plan' : 'fail' }
    if (!cmd) return { level, cmd, status: 'undeclared' }
    const exit = latest.get(normCmd(cmd))
    return { level, cmd, status: exit === undefined ? 'not-run' : exit === 0 ? 'pass' : 'fail' }
  })
}
