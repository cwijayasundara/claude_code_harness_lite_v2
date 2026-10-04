// The map of the sdlc: every step a change walks, in order, with the one the person is at. Pure over a loaded change.
import { skillRef, type Change, type Stage } from './core.ts'

export type FlowState = 'done' | 'current' | 'gate' | 'todo'
export type FlowStep = { label: string; command: string; why: string; state: FlowState }

const WHY: Record<string, string> = {
  init: 'once per repo: sensors, gates, guides',
  intent: 'classify the task, write intent.md',
  spec: 'testable behaviours (tier L)',
  plan: 'files, slices, verification',
  design: 'design.md; ONE approval covers intent + design',
  diagnose: 'root cause and fix plan',
  build: 'slice by slice, reviewed, no human',
  test: 'unit to acceptance levels',
  sensors: 'quality checks against the base branch',
  pr: 'commit, push and open the PR',
  'pr-review': 'independent review of the PR',
  notes: 'answer the spike question',
}
const COMMAND: Partial<Record<Stage, string>> = { intent: 'start' }

// The change's stages from /sdlc:init to the PR; `change` is null when none is active. Intent shows as start.
export function flowOf(initialised: boolean, change: Change | null): FlowStep[] {
  const mk = (stage: string, state: FlowState): FlowStep => {
    const name = COMMAND[stage as Stage] ?? stage
    return { label: name, command: `${skillRef(name)}${stage === 'init' ? '' : stage === 'intent' ? ' "<what you want>"' : ' <slug>'}`, why: WHY[stage] ?? '', state }
  }
  const init = mk('init', initialised ? 'done' : 'current')
  if (!change || !initialised) return [init, ...['intent', 'design', 'build', 'test', 'sensors', 'pr'].map(s => mk(s, initialised && s === 'intent' ? 'current' : 'todo'))]
  const at = change.next ? change.stages.indexOf(change.next.stage) : change.stages.length
  const steps = change.stages.map((s, i): FlowStep => mk(s, i < at ? 'done' : i > at ? 'todo' : change.next?.kind === 'approve' ? 'gate' : 'current'))
  return [init, ...steps]
}

export const flowLine = (steps: FlowStep[]): string =>
  steps.map(s => (s.state === 'done' ? `${s.label} ✓` : s.state === 'gate' ? `[${s.label} ⏸]` : s.state === 'current' ? `[${s.label}]` : s.label)).join(' → ')
