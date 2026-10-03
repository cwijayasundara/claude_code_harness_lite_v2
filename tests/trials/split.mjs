// Opus/Sonnet/Haiku cost split per agent type for one or more `claude -p --output-format json` results.
// Rate per model = that model's costUSD / its weighted tokens (input 1, cache write 1.25, cache read 0.1, output 5),
// from the JSON's modelUsage. Subagent costs come from their transcripts; main-thread Opus is the advisor.
// Usage: node split.mjs <result.json>...
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const W = u => (u.input_tokens ?? u.inputTokens ?? 0) + 1.25 * (u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0)
  + 0.1 * (u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0) + 5 * (u.output_tokens ?? u.outputTokens ?? 0)
const family = m => (/opus/.test(m) ? 'opus' : /sonnet/.test(m) ? 'sonnet' : /haiku/.test(m) ? 'haiku' : m)
const projects = path.join(os.homedir(), '.claude', 'projects')
const findSession = id => fs.readdirSync(projects).map(d => path.join(projects, d, id)).find(p => fs.existsSync(`${p}.jsonl`))
const usageRows = file => {
  const seen = new Set(); const rows = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line); const m = r.message
    if (!m?.usage || !m.model || seen.has(m.id ?? r.requestId)) continue
    seen.add(m.id ?? r.requestId); rows.push({ model: family(m.model), w: W(m.usage) })
  }
  return rows
}
const totals = {}
for (const f of process.argv.slice(2)) {
  const res = JSON.parse(fs.readFileSync(f, 'utf8'))
  const rate = Object.fromEntries(Object.entries(res.modelUsage ?? {}).map(([m, u]) => [family(m), u.costUSD / Math.max(1, W(u))]))
  const cost = Object.fromEntries(Object.entries(res.modelUsage ?? {}).map(([m, u]) => [family(m), u.costUSD]))
  const base = findSession(res.session_id)
  const subDir = base && path.join(base, 'subagents')
  const sub = {}
  if (subDir && fs.existsSync(subDir)) {
    for (const j of fs.readdirSync(subDir).filter(n => n.endsWith('.jsonl'))) {
      const type = JSON.parse(fs.readFileSync(path.join(subDir, j.replace(/\.jsonl$/, '.meta.json')), 'utf8')).agentType ?? 'unknown'
      for (const r of usageRows(path.join(subDir, j))) { const k = `${type} ${r.model}`; sub[k] = (sub[k] ?? 0) + r.w * (rate[r.model] ?? 0) }
    }
  }
  for (const [k, v] of Object.entries(sub)) totals[k] = (totals[k] ?? 0) + v
  for (const [m, c] of Object.entries(cost)) {
    const subs = Object.entries(sub).filter(([k]) => k.endsWith(` ${m}`)).reduce((n, [, v]) => n + v, 0)
    const k = m === 'opus' ? 'main (advisor) opus' : `main ${m}`
    totals[k] = (totals[k] ?? 0) + Math.max(0, c - subs)
  }
}
for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) console.log(`${k.padEnd(32)} $${v.toFixed(3)}`)
