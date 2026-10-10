import path from 'node:path'
import { readJson } from '../shared/json.ts'

export const MEM_DIR = '.rig/memory'
export type MemConfig = { enabled: boolean; minSignals: number; cooldownMin: number; maxDreamsPerDay: number; model: string; maxFiles: number; maxEntriesPerFile: number }

const num = (v: unknown, d: number): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d

export function loadMemConfig(root: string): MemConfig {
  const raw = readJson<unknown>(path.join(root, '.rig/memory.json'), {})
  const c = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    enabled: c.enabled === true,
    minSignals: num(c.minSignals, 3), cooldownMin: num(c.cooldownMin, 30), maxDreamsPerDay: num(c.maxDreamsPerDay, 6),
    model: typeof c.model === 'string' && /^[\w.:-]+$/.test(c.model) ? c.model : 'haiku',
    maxFiles: num(c.maxFiles, 12), maxEntriesPerFile: num(c.maxEntriesPerFile, 80),
  }
}

export const memDir = (root: string): string => path.join(root, MEM_DIR)
export const cacheDir = (root: string): string => path.join(root, MEM_DIR, '.cache')
