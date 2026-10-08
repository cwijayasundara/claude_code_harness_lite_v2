// The sensors.json sections added after v0.3 (gates, levels, quality, ratchet, value) and v0.6 (points, scopes, ci, ...).
import { LEVELS, QUALITY_CATEGORIES, RATCHET_NODES, isObject, isStringList, isStringMap, posInt, type GateKey, type Level, type QualityCategory, type RatchetNode, type Scope, type SensorConfig, type Band } from './model.ts'

const COUNT_RE = /^(?:exit|lines|json:[\w.]+)$/
const nonNeg = (v: unknown): v is number => typeof v === 'number' && v >= 0

export function parseV4(value: Record<string, unknown>, config: SensorConfig, errors: string[]): void {
  if (isObject(value.gates)) {
    for (const [k, v] of Object.entries(value.gates)) {
      if (!Object.hasOwn(config.gates, k)) { errors.push(`gates: unknown tier "${k}"`); continue }
      if (Array.isArray(v) && v.every(s => s === 'spec' || s === 'plan' || s === 'design')) config.gates[k as GateKey] = v as ('spec' | 'plan' | 'design')[]
      else errors.push(`gates.${k} must list spec, plan and/or design`)
    }
  } else if ('gates' in value) errors.push('gates must be an object of tier → [spec, plan, design]')
  if (isObject(value.levels)) {
    for (const [k, v] of Object.entries(value.levels)) {
      if (!LEVELS.includes(k as Level)) errors.push(`levels: unknown level "${k}"`)
      else if (typeof v === 'string' && v.trim()) config.levels[k as Level] = v
      else errors.push(`levels.${k} must be a command string`)
    }
  } else if ('levels' in value) errors.push('levels must map level names to commands')
  if (isObject(value.quality)) {
    for (const [k, v] of Object.entries(value.quality)) {
      if (!QUALITY_CATEGORIES.includes(k as QualityCategory)) { errors.push(`quality: unknown category "${k}"`); continue }
      if (!isObject(v) || typeof v.cmd !== 'string' || !v.cmd.trim() || typeof v.count !== 'string') { errors.push(`quality.${k} must be { cmd, count }`); continue }
      if (!COUNT_RE.test(v.count)) { errors.push(`quality.${k}.count must be exit, lines or json:<path>`); continue }
      config.quality[k as QualityCategory] = { cmd: v.cmd, count: v.count }
    }
  } else if ('quality' in value) errors.push('quality must map categories to { cmd, count }')
  if (isObject(value.ratchet)) {
    for (const [k, v] of Object.entries(value.ratchet)) {
      if (k === 'usd') {
        if (!isObject(v)) { errors.push('ratchet.usd must map nodes to dollars'); continue }
        for (const [n, d] of Object.entries(v)) {
          if (!RATCHET_NODES.includes(n as RatchetNode)) errors.push(`ratchet.usd: unknown node "${n}"`)
          else if (nonNeg(d) && d > 0) config.ratchet.usd[n as RatchetNode] = d
          else errors.push(`ratchet.usd.${n} must be a positive number`)
        }
      } else if (!RATCHET_NODES.includes(k as RatchetNode)) errors.push(`ratchet: unknown node "${k}"`)
      else if (posInt(v)) config.ratchet.rounds[k as RatchetNode] = v
      else errors.push(`ratchet.${k} must be a positive integer`)
    }
  } else if ('ratchet' in value) errors.push('ratchet must be an object')
  if (isObject(value.value)) {
    const v = value.value
    if ('rate' in v) { if (nonNeg(v.rate)) config.value.rate = v.rate; else errors.push('value.rate must be a non-negative number') }
    if (isObject(v.hours)) {
      for (const [t, h] of Object.entries(v.hours)) {
        if (!Object.hasOwn(config.value.hours, t)) errors.push(`value.hours: unknown tier "${t}"`)
        else if (nonNeg(h)) config.value.hours[t as 'S' | 'M' | 'L'] = h
        else errors.push(`value.hours.${t} must be a non-negative number`)
      }
    }
  } else if ('value' in value) errors.push('value must be { rate, hours }')
}

const TIERS = ['S', 'M', 'L'] as const

export function parseV6(value: Record<string, unknown>, config: SensorConfig, errors: string[]): void {
  if ('points' in value) {
    if (!isObject(value.points)) errors.push('points must be { S, M, L } positive integers')
    else for (const [t, n] of Object.entries(value.points)) {
      if (!(TIERS as readonly string[]).includes(t)) errors.push(`points: unknown tier "${t}"`)
      else if (posInt(n)) config.points[t as 'S' | 'M' | 'L'] = n
      else errors.push(`points.${t} must be a positive integer`)
    }
  }
  if ('idleGapMs' in value) { if (posInt(value.idleGapMs)) config.idleGapMs = value.idleGapMs; else errors.push('idleGapMs must be a positive integer') }
  if ('scopeLimit' in value) { if (posInt(value.scopeLimit)) config.scopeLimit = value.scopeLimit; else errors.push('scopeLimit must be a positive integer') }
  if ('ci' in value) {
    const scope = isObject(value.ci) ? value.ci.scope : undefined
    if (scope === 'affected' || scope === 'all') config.ci.scope = scope
    else errors.push('ci.scope must be "affected" or "all"')
  }
  if ('affected' in value) { if (typeof value.affected === 'string') config.affected = value.affected; else errors.push('affected must be a command string') }
  if ('sparseBase' in value) { if (typeof value.sparseBase === 'boolean') config.sparseBase = value.sparseBase; else errors.push('sparseBase must be true or false') }
  if ('evals' in value) {
    if (!isObject(value.evals)) errors.push('evals must be { minPass, maxErrors, maxTurns, timeoutMs }')
    else for (const [k, v] of Object.entries(value.evals)) {
      if (k === 'minPass') { if (typeof v === 'number' && v >= 0 && v <= 1) config.evals.minPass = v; else errors.push('evals.minPass must be a number from 0 to 1') }
      else if (k === 'maxErrors') { if (Number.isInteger(v) && (v as number) >= 0) config.evals.maxErrors = v as number; else errors.push('evals.maxErrors must be a whole number') }
      else if (k === 'maxTurns' || k === 'timeoutMs') { if (posInt(v)) config.evals[k] = v; else errors.push(`evals.${k} must be a positive integer`) }
      else errors.push(`evals: unknown key "${k}"`)
    }
  }
    if ('bands' in value) parseBands(value.bands, config, errors)
    if ('scopes' in value) parseScopes(value.scopes, config, errors)
}

const SCOPE_KEYS = new Set(['name', 'root', 'fast', 'full', 'quality', 'deps'])

function parseScopes(raw: unknown, config: SensorConfig, errors: string[]): void {
  if (!isObject(raw)) return void errors.push('scopes must map globs to { name, root, ... }')
  const names = new Set<string>()
  const parsed: Record<string, Scope> = {}
  for (const [glob, s] of Object.entries(raw)) {
    const at = `scopes["${glob}"]`
    if (!isObject(s)) { errors.push(`${at} must be an object`); continue }
    for (const k of Object.keys(s)) {
      if (k === 'levels') errors.push(`${at}.levels is not supported yet (declare levels at the top level)`)
      else if (!SCOPE_KEYS.has(k)) errors.push(`${at}: unknown key "${k}"`)
    }
    if (typeof s.name !== 'string' || !s.name.trim()) { errors.push(`${at}.name must be a non-empty string`); continue }
    if (names.has(s.name)) { errors.push(`scope name "${s.name}" is used twice`); continue }
    names.add(s.name)
    if (typeof s.root !== 'string' || !s.root || s.root.startsWith('/') || /^[A-Za-z]:/.test(s.root) || s.root.split('/').includes('..')) { errors.push(`${at}.root must be a relative path inside the repo`); continue }
    const scope: Scope = { name: s.name, root: s.root.replace(/\/+$/, '') || '.' }
    for (const k of ['fast', 'full'] as const) {
      if (!(k in s)) continue
      if (isStringMap(s[k])) scope[k] = s[k]
      else errors.push(`${at}.${k} must map names to command strings`)
    }
    if (isObject(s.quality)) {
      scope.quality = {}
      for (const [c, v] of Object.entries(s.quality)) {
        if (!QUALITY_CATEGORIES.includes(c as QualityCategory)) errors.push(`${at}.quality: unknown category "${c}"`)
        else if (isObject(v) && typeof v.cmd === 'string' && v.cmd.trim() && typeof v.count === 'string' && COUNT_RE.test(v.count)) scope.quality[c as QualityCategory] = { cmd: v.cmd, count: v.count }
        else errors.push(`${at}.quality.${c} must be { cmd, count }`)
      }
    } else if ('quality' in s) errors.push(`${at}.quality must map categories to { cmd, count }`)
    if ('deps' in s) { if (isStringList(s.deps)) scope.deps = s.deps; else errors.push(`${at}.deps must be a list of scope globs`) }
    parsed[glob] = scope
  }
  for (const [glob, s] of Object.entries(parsed)) {
    for (const d of s.deps ?? []) if (!Object.hasOwn(parsed, d)) errors.push(`scopes["${glob}"]: deps entry "${d}" is not a declared scope glob`)
  }
  config.scopes = parsed
}

const BAND_ID = /^[a-z0-9][a-z0-9-]{0,40}$/
const BAND_KEYS = new Set(['id', 'query', 'count', 'window', 'rules', 'step', 'minSd', 'tiers'])
// Read-only commands only, and no quote or shell characters: the list is passed to the diagnosis step's --allowedTools. No git log, show
// or diff: a `*` lets the model add --output=<file>, which writes.
const READ_ONLY_BASH = /^Bash\((gh (run|pr|issue) (view|list)|git (status|blame)|ls|cat|head|tail|wc)( [A-Za-z0-9_.\/=:-]+)*( \*)?\)$/
const READ_ONLY_TOOL = (t: string): boolean => /^(Read|Grep|Glob)$/.test(t) || READ_ONLY_BASH.test(t)
const ROUTES = new Set(['pull_request', 'runbook:rollback'])

// Monitoring bands for `sdlc.ts watch` (playbook p.50). Tier-2 diagnosis tools must be read-only; tier 3 may only open a pull
// request or start the rehearsed rollback.
function parseBands(raw: unknown, config: SensorConfig, errors: string[]): void {
  if (!Array.isArray(raw)) return void errors.push('bands must be a list of { id, query, count, window, step, tiers }')
  const bands: Band[] = []
  for (const [i, b] of raw.entries()) {
    const at = `bands[${i}]`
    if (!isObject(b)) { errors.push(`${at} must be an object`); continue }
    for (const k of Object.keys(b)) if (!BAND_KEYS.has(k)) errors.push(`${at}: unknown key "${k}"`)
    if (typeof b.id !== 'string' || !BAND_ID.test(b.id) || bands.some(x => x.id === b.id)) { errors.push(`${at}.id must be a unique kebab-case name`); continue }
    if (typeof b.query !== 'string' || !b.query.trim()) { errors.push(`${at}.query must be a command that prints a number or a JSON list`); continue }
    if ('count' in b && typeof b.count !== 'string') errors.push(`${at}.count must be a string`)
    if ('window' in b && !(posInt(b.window) && b.window >= 5)) errors.push(`${at}.window must be a whole number of at least 5`)
    if ('step' in b && !(typeof b.step === 'number' && b.step >= 0 && b.step <= 3)) errors.push(`${at}.step must be a number from 0 to 3 (σ per dismissal)`)
    if ('minSd' in b && !(typeof b.minSd === 'number' && b.minSd >= 0)) errors.push(`${at}.minSd must be a number of at least 0 (the σ floor, in the metric's units)`)
    if ('rules' in b && b.rules !== 'western_electric') errors.push(`${at}.rules must be "western_electric"`)
    const tier = (n: string): Record<string, unknown> => (isObject(b.tiers) && isObject(b.tiers[n]) ? b.tiers[n] : {})
    const tools = typeof tier('2').tools === 'string' && String(tier('2').tools).trim() ? String(tier('2').tools) : 'Read,Grep,Glob'
    if (!tools.split(/,(?![^(]*\))/).every(t => READ_ONLY_TOOL(t.trim()))) errors.push(`${at}.tiers.2.tools must be read-only: Read, Grep, Glob, or Bash(<gh run|pr|issue view|list, git status|blame, ls, cat, head, tail, wc> <plain arguments> *)`)
    const routes = isStringList(tier('3').routes) ? tier('3').routes as string[] : ['pull_request']
    for (const r of routes) if (!ROUTES.has(r)) errors.push(`${at}.tiers.3.routes: unknown route "${r}"`)
    bands.push({ id: b.id, query: b.query, ...(typeof b.count === 'string' ? { count: b.count } : {}), window: posInt(b.window) && b.window >= 5 ? b.window : 30, step: typeof b.step === 'number' && b.step >= 0 && b.step <= 3 ? b.step : 0.5, minSd: typeof b.minSd === 'number' && b.minSd >= 0 ? b.minSd : 0, tools, routes })
  }
  config.bands = bands
}
