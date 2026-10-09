// Each twin breaks the evidence one way and requires the assertion meant to catch it to fail.
import { Checks } from '../integration/lib/checks.mjs'
import { assertChange } from '../integration/assert/change.mjs'

// Every check matching `failing` must FAIL, every other check must PASS. Returns the surprises.
export function surprises(c, failing) {
  const bad = []
  for (const r of c.results) {
    const should = failing.some(re => re.test(r.name))
    if (should !== (r.status === 'FAIL')) bad.push(`${c.title}: ${r.name} was ${r.status}, expected ${should ? 'FAIL' : 'PASS'}`)
  }
  for (const re of failing) if (!c.results.some(r => re.test(r.name))) bad.push(`${c.title}: no check matched ${re}`)
  return bad
}

export async function runNegatives(sb, slug) {
  const bad = []
  {
    const keep = sb.read('.sdlc/approvals.jsonl')
    sb.write('.sdlc/approvals.jsonl', '')
    sb.write('stray.txt', 'left behind\n')
    const c = new Checks('twin: approval removed and a stray file')
    await assertChange(c, sb, slug, { label: slug })
    bad.push(...surprises(c, [/approved exactly the gates/, /done \(nothing left/, /tree clean/, /no scope drift/]))
    sb.write('.sdlc/approvals.jsonl', keep)
    sb.run('rm', ['-f', sb.file('stray.txt')])
  }
  {
    const c = new Checks("twin: judged as someone else's approval")
    await assertChange(c, sb, slug, { operator: 'someone-else', label: slug })
    bad.push(...surprises(c, [/every approval is the operator's/]))
  }
  return bad
}

// A design edited after its approval must put the gate back to a human.
export async function runStaleTwin(sb, slug) {
  const f = `.sdlc/changes/${slug}/design.md`
  const keep = sb.read(f)
  sb.write(f, `${keep}\n- edited after approval\n`)
  const n = JSON.parse(sb.sdlc(['next', slug, '--json']).stdout)
  sb.write(f, keep)
  return n.verdict === 'human' ? [] : [`stale approval: next said ${n.verdict}, expected human`]
}

// A workflow calling a subcommand the CLI lacks, and a gate with an empty approval, must both be caught.
export async function runDeployNegatives(sb) {
  const { assertWorkflowText } = await import('./assert/deploy.mjs')
  const bad = []
  const c = new Checks('twin: workflow calls a command that does not exist')
  await assertWorkflowText(c, 'fake.yml', 'name: x\njobs:\n  a:\n    steps:\n      - run: node .sdlc/bin/sdlc.ts nonsense-cmd\n')
  bad.push(...surprises(c, [/every sdlc\.ts command it calls exists/]))
  const g = new Checks('twin: workflow that is not YAML with jobs')
  await assertWorkflowText(g, 'empty.yml', 'name: x\n')
  bad.push(...surprises(g, [/parses as YAML with jobs/]))
  return bad
}
