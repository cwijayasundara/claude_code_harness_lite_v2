// What the sessions did, read from `claude -p --output-format stream-json --verbose` transcripts: cost, turns, permission
// denials, errors, and every skill and agent the model invoked.
import fs from 'node:fs'

export function readSession(file) {
  const s = { file, costUsd: 0, turns: 0, ms: 0, isError: true, denials: [], skills: [], agents: [], ended: false }
  if (!fs.existsSync(file)) return s
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content ?? []) {
        if (c.type !== 'tool_use') continue
        if (c.name === 'Skill') s.skills.push(String(c.input?.skill ?? c.input?.command ?? ''))
        if (c.name === 'Agent' || c.name === 'Task') s.agents.push(String(c.input?.subagent_type ?? 'general-purpose'))
      }
    }
    if (ev.type === 'result') {
      s.ended = true
      s.costUsd = ev.total_cost_usd ?? 0
      s.turns = ev.num_turns ?? 0
      s.ms = ev.duration_ms ?? 0
      s.isError = Boolean(ev.is_error)
      s.denials = ev.permission_denials ?? []
    }
  }
  return s
}

export const totals = sessions => ({
  costUsd: sessions.reduce((n, s) => n + s.costUsd, 0),
  turns: sessions.reduce((n, s) => n + s.turns, 0),
  ms: sessions.reduce((n, s) => n + s.ms, 0),
  denials: sessions.flatMap(s => s.denials),
})

// rig's skills are rig-* in a standalone repo and rig:* from the plugin, and its stages call two built-ins (pr-review runs
// code-review; security-review where a stage names it). Anything else means a plugin leaked into the run.
const RIG_SKILL = /^(?:rig[-:]|code-review$|security-review$)/

export async function assertProcess(c, sessions, { label = 'phase' } = {}) {
  await c.check(`${label}: every session ran to a result`, () =>
    (sessions.length > 0 && sessions.every(s => s.ended)) || sessions.filter(s => !s.ended).map(s => s.file).join(', ') || 'no sessions')
  await c.check(`${label}: no session ended in error`, () => sessions.every(s => !s.isError) || sessions.filter(s => s.isError).map(s => s.file).join(', '))
  await c.check(`${label}: 0 permission denials`, () => {
    const d = totals(sessions).denials
    return d.length === 0 || d.map(x => `${x.tool_name}: ${JSON.stringify(x.tool_input).slice(0, 120)}`).join(' | ')
  })
  await c.check(`${label}: only rig skills invoked`, () => {
    const other = sessions.flatMap(s => s.skills).filter(n => !RIG_SKILL.test(n))
    return other.length === 0 || [...new Set(other)].join(', ')
  })
  await c.check(`${label}: no skill-load fallbacks`, () => {
    const hit = sessions.filter(s => fs.existsSync(s.file) && /skill-load-failed/.test(fs.readFileSync(s.file, 'utf8')))
    return hit.length === 0 || hit.map(s => s.file).join(', ')
  })
}
