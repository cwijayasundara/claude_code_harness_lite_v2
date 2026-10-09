import type { Index, State } from './core.ts'
import type { Config } from './config.ts'
import { archHash } from './state.ts'

export type PageTask = { module: string; reason: 'new' | 'changed' | 'stale'; files: string[] }
export type Plan = { prose: PageTask[]; pending: PageTask[]; architecture: boolean }

export function planRefresh(idx: Index, state: State, cfg: Config): Plan {
  const due: { task: PageTask; rank: number }[] = []
  for (const m of Object.values(idx.modules)) {
    if (m.structureOnly) continue
    const s = state.modules[m.name]
    const reason = !s ? 'new' : s.hash !== m.hash ? 'changed' : s.status === 'stale' ? 'stale' : null
    if (reason) due.push({ task: { module: m.name, reason, files: m.files }, rank: m.usedBy.length })
  }
  due.sort((a, b) => b.rank - a.rank || a.task.module.localeCompare(b.task.module))
  const tasks = due.map(d => d.task)
  return {
    prose: tasks.slice(0, cfg.maxPages),
    pending: tasks.slice(cfg.maxPages),
    architecture: tasks.length > 0 || state.architectureHash !== archHash(idx),
  }
}
