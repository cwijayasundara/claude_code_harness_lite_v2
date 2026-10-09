// The operator: plays the human at every gate, in code. Reads only `next --json` and `status --json`, never prose.
const GATES = ['spec', 'plan', 'design', 'impact']

function json(sb, args) {
  const r = sb.sdlc(args)
  if (r.status !== 0) throw new Error(`sdlc ${args.join(' ')} exited ${r.status}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`)
  return JSON.parse(r.stdout)
}

export async function runRoute({ sb, slug, driver, operator = 'operator', maxSteps = 10, expectGates }) {
  const approved = []
  const done = new Set()
  let steps = 0
  for (;;) {
    const s = json(sb, ['next', slug, '--json'])
    if (s.verdict === 'ready' || s.verdict === 'done') return { steps, approved, end: s.verdict }
    if (s.verdict === 'blocked') throw new Error(`${slug}: blocked: ${s.reason}`)
    if (s.verdict === 'human') {
      const st = json(sb, ['status', '--json']).changes.find(c => c.slug === slug)
      const gate = st?.next?.kind === 'approve' ? st.next.gate : undefined
      const allowed = expectGates ? expectGates(slug) : GATES
      if (!gate || !GATES.includes(gate) || !allowed.includes(gate)) {
        throw new Error(`${slug}: unexpected gate ${gate ?? s.reason} at node ${s.node} (allowed: ${allowed.join(', ')})`)
      }
      const r = sb.sdlc(['approve', slug, gate, '--by', operator], { human: true })
      if (r.status !== 0) throw new Error(`approve ${gate} failed: ${(r.stderr || r.stdout).trim()}`)
      approved.push(gate)
      continue
    }
    const key = `${s.node}:${s.round}`
    if (done.has(key)) throw new Error(`${slug}: no progress at ${s.node} (round ${s.round})`)
    if (++steps > maxSteps) throw new Error(`${slug}: more than ${maxSteps} steps`)
    await driver.step(s.node, { slug, round: s.round })
    done.add(key)
  }
}
