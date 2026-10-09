import test from 'node:test'
import assert from 'node:assert/strict'
import { runRoute } from './operator.mjs'

// A fake sandbox: sdlc() answers from canned replies keyed by subcommand.
function fakeSb(replies) {
  const calls = []
  return {
    calls,
    sdlc(args, opts) {
      calls.push({ args, opts })
      const q = replies[args[0]]
      const r = typeof q === 'function' ? q(args) : q
      return { status: 0, stdout: JSON.stringify(r), stderr: '' }
    },
  }
}
const seq = items => { let i = 0; return () => items[Math.min(i++, items.length - 1)] }
const nextOf = (node, verdict, extra = {}) => ({ slug: 's', node, verdict, reason: '', command: '', round: 0, ...extra })

test('approves a human gate with by=operator and human=true, then continues', async () => {
  const sb = fakeSb({
    next: seq([nextOf('design', 'human'), nextOf('build', 'continue'), nextOf(null, 'ready')]),
    status: { changes: [{ slug: 's', next: { kind: 'approve', gate: 'design' } }] },
    approve: {},
  })
  const done = []
  const out = await runRoute({ sb, slug: 's', driver: { step: async node => done.push(node) } })
  assert.deepEqual(done, ['build'])
  assert.deepEqual(out.approved, ['design'])
  const approve = sb.calls.find(c => c.args[0] === 'approve')
  assert.deepEqual(approve.args, ['approve', 's', 'design', '--by', 'operator'])
  assert.equal(approve.opts.human, true)
  assert.equal(out.end, 'ready')
})

test('fails on a gate the path should not have', async () => {
  const sb = fakeSb({
    next: seq([nextOf('plan', 'human')]),
    status: { changes: [{ slug: 's', next: { kind: 'approve', gate: 'plan' } }] },
  })
  await assert.rejects(
    runRoute({ sb, slug: 's', driver: { step: async () => {} }, expectGates: () => ['design'] }),
    /unexpected gate plan/)
})

test('fails on blocked, with the reason', async () => {
  const sb = fakeSb({ next: seq([nextOf('build', 'blocked', { reason: 'sensors: secrets' })]) })
  await assert.rejects(runRoute({ sb, slug: 's', driver: { step: async () => {} } }), /blocked.*sensors: secrets/)
})

test('fails when the same node and round repeats after a step (no progress)', async () => {
  const sb = fakeSb({ next: seq([nextOf('build', 'continue')]) })
  await assert.rejects(runRoute({ sb, slug: 's', driver: { step: async () => {} } }), /no progress at build/)
})

test('fails after maxSteps', async () => {
  let n = 0
  const sb = fakeSb({ next: () => nextOf('build', 'continue', { round: n++ }) })
  await assert.rejects(runRoute({ sb, slug: 's', driver: { step: async () => {} }, maxSteps: 3 }), /more than 3 steps/)
})

test('a human verdict on budget or tier is a failure, not an approval', async () => {
  const sb = fakeSb({
    next: seq([nextOf('build', 'human')]),
    status: { changes: [{ slug: 's', next: { kind: 'approve', gate: 'budget' } }] },
  })
  await assert.rejects(runRoute({ sb, slug: 's', driver: { step: async () => {} } }), /unexpected gate budget/)
})

test('resolves policy concerns the approval refuses on, then approves and reports them', async () => {
  const files = { '.sdlc/changes/s/design.md': '# d\n\n## Concerns\n- [policy-security] Rule 3: sku not validated → owner: <the team>\n- [policy-security] Rule 5: no audit → owner: <the team>\n' }
  let tries = 0
  const sb = {
    read: f => files[f] ?? '',
    write: (f, t) => { files[f] = t },
    sdlc(args) {
      if (args[0] === 'next') return { status: 0, stdout: JSON.stringify(tries ? nextOf(null, 'ready') : nextOf('design', 'human')), stderr: '' }
      if (args[0] === 'status') return { status: 0, stdout: JSON.stringify({ changes: [{ slug: 's', next: { kind: 'approve', gate: 'design' } }] }), stderr: '' }
      if (args[0] === 'approve') {
        if (!/→ resolved:/.test(files['.sdlc/changes/s/design.md'])) {
          return { status: 1, stdout: '', stderr: 'resolve the concern(s) in s/design.md with their policy owners before approving: add " → resolved: <decision> (<owner>)" to each:\n  - [policy-security] Rule 3\n' }
        }
        tries++
        return { status: 0, stdout: 'approved', stderr: '' }
      }
      throw new Error(`unexpected ${args}`)
    },
  }
  const out = await runRoute({ sb, slug: 's', driver: { step: async () => {} } })
  assert.deepEqual(out.approved, ['design'])
  assert.equal(out.resolvedConcerns, 2)
  assert.match(files['.sdlc/changes/s/design.md'], /Rule 3: sku not validated.*→ resolved: .*\(operator\)/)
})
