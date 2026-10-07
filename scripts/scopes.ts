// Scopes: which parts of a monorepo a diff touches, from globs and declared dependency edges only (no import parsing).
import { ROOT } from './core.ts'
import { matchesAny, type SensorConfig } from './model.ts'
import { runCommand } from './runs.ts'

export function scopeOf(file: string, config: SensorConfig): string | null {
  let best: string | null = null
  for (const glob of Object.keys(config.scopes)) {
    if (matchesAny(file, [glob]) && (best === null || glob.length > best.length)) best = glob
  }
  return best
}

const nameOf = (config: SensorConfig, glob: string): string => config.scopes[glob]?.name ?? glob

// extra === null means the `affected` command failed: fail closed, every declared scope is affected.
export function selectScopes(files: string[], config: SensorConfig, extra: string[] | null = []): { touched: string[]; affected: string[]; unscoped: string[] } {
  const touchedGlobs = new Set<string>()
  const unscoped: string[] = []
  for (const f of files) {
    const g = scopeOf(f, config)
    if (g) touchedGlobs.add(g)
    else unscoped.push(f)
  }
  // A scope that lists an affected scope's glob in deps is affected too, transitively (a visited set ends cycles).
  const affected = new Set(touchedGlobs)
  for (let grew = true; grew;) {
    grew = false
    for (const [glob, s] of Object.entries(config.scopes)) {
      if (!affected.has(glob) && (s.deps ?? []).some(d => affected.has(d))) { affected.add(glob); grew = true }
    }
  }
  const byName = new Set(Object.values(config.scopes).map(s => s.name))
  const names = extra === null ? byName : new Set([...[...affected].map(g => nameOf(config, g)), ...extra.filter(n => byName.has(n))])
  return { touched: [...touchedGlobs].map(g => nameOf(config, g)).sort(), affected: [...names].sort(), unscoped }
}

// The roots of the named scopes and of everything they depend on, transitively: what a sparse base checkout must contain.
export function closureRoots(config: SensorConfig, names: string[]): string[] {
  const globs = new Set(Object.entries(config.scopes).filter(([, s]) => names.includes(s.name)).map(([g]) => g))
  for (let grew = true; grew;) {
    grew = false
    for (const g of [...globs]) for (const d of config.scopes[g]?.deps ?? []) if (!globs.has(d)) { globs.add(d); grew = true }
  }
  return [...new Set([...globs].map(g => config.scopes[g]?.root ?? ''))].filter(Boolean).sort()
}

// The optional `affected` command (turbo, nx, pnpm -r ...) prints scope names, one per line; names that are not declared are ignored.
// null: it was declared but failed or timed out, so the caller must treat every scope as affected.
export function extraScopes(config: SensorConfig, timeoutMs = 60_000): string[] | null {
  if (!config.affected.trim()) return []
  // The whole stdout, not the run row's 30-line tail of stdout+stderr: a long list must not lose its first names.
  let stdout = ''
  const row = runCommand(config.affected, { cwd: ROOT, timeoutMs, stdout: t => { stdout = t } })
  if (row.exit !== 0 || row.timedOut) return null
  const known = new Set(Object.values(config.scopes).map(s => s.name))
  return stdout.split('\n').map(l => l.trim()).filter(l => known.has(l))
}

export type PlannedCommand = { key: string; cmd: string; cwd?: string }

// The commands to run for a set of changed files. No files, or no scopes: the top-level commands, as before. With scopes: each
// affected scope's commands in its root, plus the top-level ones when a changed file is unscoped. extra === null fails closed.
export function scopeCommands(prefix: 'fast' | 'full', config: SensorConfig, files: string[] | 'all' | undefined, extra: string[] | null = []): PlannedCommand[] {
  const root: PlannedCommand[] = Object.entries(config[prefix]).map(([name, cmd]) => ({ key: `${prefix}.${name}`, cmd }))
  if (files === undefined || !Object.keys(config.scopes).length) return root
  const sel = files === 'all' ? null : selectScopes(files, config, extra)
  const out: PlannedCommand[] = !sel || sel.unscoped.length ? [...root] : []
  for (const s of Object.values(config.scopes)) {
    if (sel && !sel.affected.includes(s.name)) continue
    for (const [name, cmd] of Object.entries(s[prefix] ?? {})) out.push({ key: `${s.name}:${prefix}.${name}`, cmd, cwd: s.root })
  }
  return out
}
