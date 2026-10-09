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

// A design edited after its approval must put the design gate back to a human (not merely any human verdict).
export async function runStaleTwin(sb, slug) {
  const f = `.sdlc/changes/${slug}/design.md`
  const keep = sb.read(f)
  const bad = []
  try {
    const before = JSON.parse(sb.sdlc(['next', slug, '--json']).stdout).verdict
    sb.write(f, `${keep}\n- edited after approval\n`)
    const n = JSON.parse(sb.sdlc(['next', slug, '--json']).stdout)
    const gate = JSON.parse(sb.sdlc(['status', '--json']).stdout).changes.find(c => c.slug === slug)?.next?.gate
    if (before === 'human') bad.push(`stale approval: the change was already waiting on a human before the edit`)
    if (n.verdict !== 'human' || gate !== 'design') bad.push(`stale approval: next said ${n.verdict} (gate ${gate}), expected human at design`)
  } finally {
    sb.write(f, keep)
  }
  return bad
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

// A series with no spike must not raise a breach; an incident file missing its class must be refused.
export async function runMaintainNegatives(out) {
  const { createSandbox } = await import('../integration/lib/sandbox.mjs')
  const { assertWatch, assertIncident } = await import('./assert/maintain.mjs')
  const bad = []
  const sb = createSandbox({ name: 'twin-watch', out })
  sb.write('.sdlc/sensors.json', '{}\n')
  const w = new Checks('twin: no spike in the series')
  await assertWatch(w, sb, { spike: 10 })
  bad.push(...surprises(w, [/a point far beyond 3 sigma is tier 3/]))
  sb.write('.sdlc/incidents/x.md', '---\nseverity: sev3\nescaped: true\ndetected: now\nrestored:\n---\nbody\n')
  const i = new Checks('twin: incident without a class')
  await assertIncident(i, sb, '.sdlc/incidents/x.md')
  bad.push(...surprises(i, [/has class, severity, escaped, detected/]))
  return bad
}

// An in-band series that hides a spike must trip the in-band check (it used to read a file `watch` never writes).
export async function runWatchSpikeTwin(out) {
  const { createSandbox } = await import('../integration/lib/sandbox.mjs')
  const { assertWatch } = await import('./assert/maintain.mjs')
  const sb = createSandbox({ name: 'twin-watch-spike', out })
  sb.write('.sdlc/sensors.json', '{}\n')
  const c = new Checks('twin: a spike hidden in the in-band series')
  await assertWatch(c, sb, { inBand: [10, 11, 10, 9, 10, 10, 11, 10, 9, 10, 10, 11, 60] })
  return surprises(c, [/in-band points are tier 0 and raise no breach/])
}
