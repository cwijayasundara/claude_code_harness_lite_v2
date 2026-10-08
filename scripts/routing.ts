// Role by tier routing (spec 2026-10-08): the role and the change's tier pick the model and effort for every model call.
// Cheapest above a per-role floor; the floor clamps last, so no override or retry goes below it. Pure: no fs, git or process.
import type { ChangeType, Tier } from './core.ts'

export type Role = 'scout' | 'researcher' | 'architect' | 'implementer' | 'slice-review' | 'reviewer' | 'referee' | 'triage'
export type Model = 'haiku' | 'sonnet' | 'opus'
export type Effort = 'low' | 'medium' | 'high'
export type Route = { model: Model; effort: Effort } | 'main'
export type RoutingOverride = Partial<Record<Role, Partial<Record<Tier, { model: Model; effort?: Effort }>>>>
// Budget pressure (spend governance spec §7): tight eases review effort one step; floors still clamp.
export type Pressure = 'normal' | 'tight'

export const ROLES: Role[] = ['scout', 'researcher', 'architect', 'implementer', 'slice-review', 'reviewer', 'referee', 'triage']
const MODELS: Model[] = ['haiku', 'sonnet', 'opus']
const EFFORTS: Effort[] = ['low', 'medium', 'high']
const TIERS: Tier[] = ['S', 'M', 'L']

const at = (model: Model, effort: Effort): Route => ({ model, effort })
const same = (x: Route): Record<Tier, Route> => ({ S: x, M: x, L: x })
// Spec §4. Main means the skill drafts in its own thread (a subagent costs more than it saves for a short S or M plan).
export const TABLE: Record<Role, Record<Tier, Route>> = {
  scout: same(at('haiku', 'low')),
  researcher: same(at('haiku', 'low')),
  architect: { S: 'main', M: 'main', L: at('opus', 'high') },
  implementer: { S: at('haiku', 'medium'), M: at('sonnet', 'medium'), L: at('sonnet', 'high') },
  'slice-review': same(at('sonnet', 'high')),
  reviewer: { S: at('sonnet', 'medium'), M: at('sonnet', 'high'), L: at('opus', 'high') },
  referee: { S: at('sonnet', 'medium'), M: at('sonnet', 'medium'), L: at('sonnet', 'high') },
  triage: same(at('haiku', 'low')),
}
// The lowest model a role may run on, per tier. Reviews are decision points: never Haiku. Code above tier S: never Haiku.
const FLOOR: Record<Role, Record<Tier, Model>> = {
  scout: { S: 'haiku', M: 'haiku', L: 'haiku' },
  researcher: { S: 'haiku', M: 'haiku', L: 'haiku' },
  architect: { S: 'haiku', M: 'haiku', L: 'opus' },
  implementer: { S: 'haiku', M: 'sonnet', L: 'sonnet' },
  'slice-review': { S: 'sonnet', M: 'sonnet', L: 'sonnet' },
  reviewer: { S: 'sonnet', M: 'sonnet', L: 'sonnet' },
  referee: { S: 'sonnet', M: 'sonnet', L: 'sonnet' },
  triage: { S: 'haiku', M: 'haiku', L: 'haiku' },
}

// One retry step: effort first, then the next model at medium; opus high is the ceiling.
function up(x: { model: Model; effort: Effort }): { model: Model; effort: Effort } {
  const e = EFFORTS.indexOf(x.effort)
  if (e < EFFORTS.length - 1) return { model: x.model, effort: EFFORTS[e + 1]! }
  const m = MODELS.indexOf(x.model)
  return m < MODELS.length - 1 ? { model: MODELS[m + 1]!, effort: 'medium' } : x
}

export function route(role: Role, type: ChangeType, tier: Tier, round = 0, override: RoutingOverride = {}): { route: Route; warning?: string } {
  const t: Tier = type === 'greenfield' ? 'L' : tier
  const base = TABLE[role][t]
  if (base === 'main') return { route: 'main' }
  const o = override[role]?.[t]
  let x = { model: o?.model ?? base.model, effort: o?.effort ?? base.effort }
  if (role === 'implementer') for (let i = 0; i < round; i++) x = up(x)
  const floor = FLOOR[role][t]
  if (MODELS.indexOf(x.model) >= MODELS.indexOf(floor)) return { route: x }
  return { route: { model: floor, effort: x.effort }, warning: `routing: ${role} at tier ${t} cannot go below its floor ${floor}; using ${floor}` }
}

export function routes(type: ChangeType, tier: Tier, round = 0, override: RoutingOverride = {}): { routes: Record<Role, Route>; warnings: string[] } {
  const all = {} as Record<Role, Route>
  const warnings: string[] = []
  for (const role of ROLES) {
    const r = route(role, type, tier, round, override)
    all[role] = r.route
    if (r.warning) warnings.push(r.warning)
  }
  return { routes: all, warnings }
}

// Scout, researcher and triage are pinned in their own files: a per-launch alias could resolve to another model outside the template env.
const PINNED: Record<string, string> = { scout: 'agents/scout.md', researcher: 'agents/researcher.md', triage: 'templates/rig-triage.yml' }

// sensors.json "routing": { "<role>": { "<tier>": "model" | "model:effort" } }. Architect routes only tier L (S and M draft in the main thread).
export function parseRouting(value: unknown, errors: string[]): RoutingOverride {
  const out: RoutingOverride = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push('routing must be { "<role>": { "S" | "M" | "L": "model" or "model:effort" } }')
    return out
  }
  for (const [role, tiers] of Object.entries(value)) {
    if (!(ROLES as string[]).includes(role)) { errors.push(`routing: unknown role "${role}" (one of ${ROLES.join(', ')})`); continue }
    if (role in PINNED) { errors.push(`routing.${role}: pinned in ${PINNED[role]}; edit that file instead`); continue }
    if (typeof tiers !== 'object' || tiers === null || Array.isArray(tiers)) { errors.push(`routing.${role} must map tiers to "model" or "model:effort"`); continue }
    for (const [tier, spec] of Object.entries(tiers)) {
      if (!(TIERS as string[]).includes(tier)) { errors.push(`routing.${role}: unknown tier "${tier}"`); continue }
      if (role === 'architect' && tier !== 'L') { errors.push(`routing.architect.${tier}: tier S and M plans are drafted in the main thread`); continue }
      const [model, effort, ...rest] = typeof spec === 'string' ? spec.split(':') : []
      if (!(MODELS as string[]).includes(model ?? '') || (effort !== undefined && !(EFFORTS as string[]).includes(effort)) || rest.length) {
        errors.push(`routing.${role}.${tier} must be "haiku", "sonnet" or "opus", optionally ":low", ":medium" or ":high"`)
        continue
      }
      const entry = (out[role as Role] ??= {})
      entry[tier as Tier] = effort ? { model: model as Model, effort: effort as Effort } : { model: model as Model }
    }
  }
  return out
}

// The ledger records agent type and stage, not role; one reviewer agent serves two roles, split by the stage it ran in.
export function roleOf(agentType: string | undefined, stage: string | null): Role | 'other' {
  const name = (agentType ?? '').replace(/^rig[:-]/, '')
  if (name === 'reviewer') return stage === 'build' ? 'slice-review' : 'reviewer'
  return (ROLES as string[]).includes(name) ? (name as Role) : 'other'
}
