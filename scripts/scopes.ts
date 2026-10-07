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

export function selectScopes(files: string[], config: SensorConfig, extra: string[] = []): { touched: string[]; affected: string[]; unscoped: string[] } {
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
  const names = new Set([...[...affected].map(g => nameOf(config, g)), ...extra.filter(n => byName.has(n))])
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
export function extraScopes(config: SensorConfig): string[] {
  if (!config.affected.trim()) return []
  const row = runCommand(config.affected, { cwd: ROOT, timeoutMs: 60_000 })
  if (row.exit !== 0) return []
  const known = new Set(Object.values(config.scopes).map(s => s.name))
  return row.tail.split('\n').map(l => l.trim()).filter(l => known.has(l))
}
