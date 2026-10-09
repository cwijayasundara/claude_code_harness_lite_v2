// The live driver: real `claude -p` sessions running the vendored skills with the real model. Costs money; capped.
import fs from 'node:fs'
import path from 'node:path'
import { readSession, totals } from '../../integration/assert/process.mjs'
import { PLUGIN } from '../../integration/lib/sandbox.mjs'

// One shared session log per run, so the spend cap covers every phase.
export function createSessions({ sb, out, capUsd = 6, model = 'sonnet' }) {
  const sessions = []
  const run = (label, prompt, { withPlugin = false, cont = false } = {}) => {
    const spent = totals(sessions).costUsd
    if (spent >= capUsd) throw new Error(`spend cap $${capUsd} reached ($${spent.toFixed(2)})`)
    const file = path.join(out, 'sessions', `${String(sessions.length).padStart(2, '0')}-${label}.jsonl`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      '--model', model, '--max-budget-usd', String(Math.min(6, capUsd - spent).toFixed(2)), '--setting-sources', 'project,local',
      ...(withPlugin ? ['--plugin-dir', PLUGIN] : []), ...(cont ? ['--continue'] : [])]
    const r = sb.run('claude', args, { timeout: 18 * 60_000 })
    fs.writeFileSync(file, r.stdout ?? '')
    if (r.status !== 0 && !r.stdout) throw new Error(`claude exited ${r.status}: ${(r.stderr ?? '').split('\n')[0]}`)
    const s = readSession(file)
    sessions.push(s)
    console.log(`  live ${label}: $${s.costUsd.toFixed(2)}, ${s.turns} turns, ${s.denials.length} denial(s), total $${totals(sessions).costUsd.toFixed(2)} of $${capUsd}`)
    return s
  }
  return { sessions, run }
}

export function liveDriver(sb, phase, { sessions }) {
  return {
    sessions: sessions.sessions,
    async begin() {
      sessions.run(`${phase.id}-start`, phase.prompt)
      const active = () => JSON.parse(sb.sdlc(['status', '--json']).stdout).active
      // /rig-start can end its turn while a scout is still running; continue the same conversation up to twice.
      for (let i = 0; i < 2 && !active(); i++) {
        sessions.run(`${phase.id}-start-cont${i + 1}`, 'Continue /rig-start where you stopped: classify the change, run sdlc.ts new, and write intent.md.', { cont: true })
      }
      if (!active()) throw new Error(`${phase.id}: /rig-start created no change after 2 continuations`)
      return active()
    },
    async step(node) {
      sessions.run(`${phase.id}-${node}`, '/rig-next — continue through the next node; commit on the branch')
    },
  }
}
