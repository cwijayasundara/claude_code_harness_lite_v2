// The context sensor (proposal 2026-10-08 §3.3.2 and §3.3.3): a session whose first call is already heavy is paying for
// plugins on every call, a turn over the hard limit is paying for history, and a plugin that spawns its own model
// sessions from a hook is spending behind the model's back. All three are measured here, never guessed. Pure except for
// the two readers at the bottom, which take their roots as arguments so tests can point them at a temp home.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { UsageRow } from './core.ts'

export const FIRST_CALL_LIMIT = 25_000
export const TURN_LIMIT = 150_000

const kilo = (n: number): string => `${Math.round(n / 1000)}k`

// Warnings the mod shows as toasts (log-usage prints one per line). Main rows only: a subagent's context is its brief.
export function contextWarnings(row: Partial<UsageRow>, plugins: string[]): string[] {
  if (row.kind !== 'main') return []
  const ctx = row.ctx ?? 0
  const out: string[] = []
  if (row.first && ctx > FIRST_CALL_LIMIT) {
    out.push(`rig: the first call of this session is ${kilo(ctx)} tokens before any work (limit ${kilo(FIRST_CALL_LIMIT)}); every call re-reads it. enabled plugins: ${plugins.length ? plugins.join(', ') : 'none listed'}. Disable the ones this repo does not use.`)
  }
  if (ctx > TURN_LIMIT) out.push(`rig: context is ${kilo(ctx)} (over ${kilo(TURN_LIMIT)}): finish this step, then /compact (the active change lives in .sdlc/STATE.md).`)
  return out
}

const readJson = (file: string): Record<string, unknown> => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> } catch { return {} }
}

// Plugins switched on in the user settings and the project settings, in that order, each once.
export function enabledPlugins(home = os.homedir(), root = process.cwd()): string[] {
  const out: string[] = []
  for (const file of [path.join(home, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.json')]) {
    const enabled = readJson(file).enabledPlugins
    if (!enabled || typeof enabled !== 'object') continue
    for (const [name, on] of Object.entries(enabled as Record<string, unknown>)) if (on === true && !out.includes(name)) out.push(name)
  }
  return out
}

// Claude Code keeps a project's transcripts under ~/.claude/projects/<cwd with every non-alphanumeric character as "-">.
export const projectSlug = (root: string): string => root.replace(/[^a-zA-Z0-9]/g, '-')

export type BackgroundSession = { file: string; entrypoint: string; at: string }
export type BackgroundSummary = { total: number; by_entrypoint: Record<string, number>; sessions: BackgroundSession[] }

// Every transcript in the window whose first stamped line names an entrypoint other than the interactive cli:
// sdk-py, sdk-ts and the like are hook- or plugin-spawned model sessions that no usage row of ours records.
export function backgroundSessions(root: string, since: number, home = os.homedir()): BackgroundSummary {
  const dir = path.join(home, '.claude', 'projects', projectSlug(root))
  const sessions: BackgroundSession[] = []
  let files: string[] = []
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')) } catch { return { total: 0, by_entrypoint: {}, sessions } }
  for (const f of files) {
    const head = readHead(path.join(dir, f))
    for (const line of head.split('\n')) {
      let d: { entrypoint?: unknown; timestamp?: unknown }
      try { d = JSON.parse(line) as typeof d } catch { continue }
      if (typeof d.entrypoint !== 'string' || typeof d.timestamp !== 'string') continue
      if (d.entrypoint !== 'cli' && Date.parse(d.timestamp) >= since) sessions.push({ file: f, entrypoint: d.entrypoint, at: d.timestamp })
      break
    }
  }
  sessions.sort((a, b) => a.at.localeCompare(b.at))
  const by_entrypoint: Record<string, number> = {}
  for (const s of sessions) by_entrypoint[s.entrypoint] = (by_entrypoint[s.entrypoint] ?? 0) + 1
  return { total: sessions.length, by_entrypoint, sessions }
}

// The first 64 KB is enough to find the first stamped line; a transcript can be hundreds of MB.
function readHead(file: string): string {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}
