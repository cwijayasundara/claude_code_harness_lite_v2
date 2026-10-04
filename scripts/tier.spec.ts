// The tier and type are recorded in ratchet.json at creation; intent.md can raise them but never lower them without a person.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

let repo: string
const intentPath = (slug: string): string => path.join(repo, `.sdlc/changes/${slug}/intent.md`)
const setIntent = (slug: string, from: string, to: string): void => fs.writeFileSync(intentPath(slug), fs.readFileSync(intentPath(slug), 'utf8').replace(from, to))
const status = (): { changes: { slug: string; tier: string }[]; step: { verdict: string; node: string } } => JSON.parse(sdlc(repo, ['status', '--json']).stdout)
const preEdit = (rel: string): string | undefined => {
  const r = sdlc(repo, ['hook', 'pre-edit'], { input: JSON.stringify({ tool_input: { file_path: path.join(repo, rel), content: 'x' } }) })
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : undefined
}
const ratchetJson = (slug: string) => JSON.parse(fs.readFileSync(path.join(repo, `.sdlc/changes/${slug}/ratchet.json`), 'utf8'))
const planned = (slug: string): void => {
  write(repo, `.sdlc/changes/${slug}/design.md`, '## Files\n- src/**\n## Verification\n- `npm test`\n## Open questions\nnone\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'plan')
}
beforeEach(() => {
  repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: 'npm test' } }))
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  planned('big')
})

test('createChange records the tier and type in ratchet.json', () => {
  assert.equal(ratchetJson('big').tier, 'L')
  assert.equal(ratchetJson('big').type, 'feature')
})

test('editing intent.md from tier L to M does not remove the plan gate or enable auto-approval', () => {
  assert.equal(status().step.verdict, 'human')
  setIntent('big', 'tier: L', 'tier: M')
  const s = status()
  assert.equal(s.step.verdict, 'human')
  assert.equal(s.changes[0]?.tier, 'L')
  assert.notEqual(preEdit('src/a.js'), 'allow')
})

test('status warns when intent.md differs from the recorded tier', () => {
  setIntent('big', 'tier: L', 'tier: M')
  assert.match(sdlc(repo, ['status']).stdout, /warn: big: tier changed in intent\.md \(L → M\): \/sdlc-approve big tier M feature to accept/)
})

test('a change folder with no recorded tier is gated as L, whatever intent.md says', () => {
  write(repo, '.sdlc/changes/hand/intent.md', '---\nslug: hand\ntype: feature\ntier: S\n---\n# Hand\n')
  write(repo, '.sdlc/changes/hand/spec.md', '# Spec\n## Open questions\nnone\n')
  write(repo, '.sdlc/changes/hand/plan.md', '## Files\n- src/**\n## Open questions\nnone\n')
  write(repo, '.sdlc/STATE.md', '---\nchange: hand\n---\n')
  const s = status()
  assert.equal(s.changes.find(c => c.slug === 'hand')?.tier, 'L')
  assert.equal(s.step.verdict, 'human')
})

test('approve tier is human-only', () => {
  setIntent('big', 'tier: L', 'tier: M')
  const r = sdlc(repo, ['approve', 'big', 'tier', 'M'])
  assert.equal(r.code, 3)
  assert.equal(ratchetJson('big').tier, 'L')
})

test('a person approving tier records the lowered tier and gating follows it', () => {
  setIntent('big', 'tier: L', 'tier: S')
  const r = sdlc(repo, ['approve', 'big', 'tier', 'S'], { env: { SDLC_HUMAN: '1' } })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /L → S/)
  assert.equal(ratchetJson('big').tier, 'S')
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/big/events.jsonl'), 'utf8'), /"kind":"tier".*L → S/)
  assert.equal(status().changes[0]?.tier, 'S')
  assert.equal(status().step.verdict, 'continue')
  assert.doesNotMatch(sdlc(repo, ['status']).stdout, /tier changed/)
})

test('raising the tier in intent.md takes effect without approval', () => {
  sdlc(repo, ['new', 'small', '--type', 'feature', '--tier', 'S'])
  write(repo, '.sdlc/STATE.md', '---\nchange: small\n---\n')
  setIntent('small', 'tier: S', 'tier: L')
  const s = status()
  assert.equal(s.changes.find(c => c.slug === 'small')?.tier, 'L')
  assert.equal(s.step.node, 'design')
})

test('type greenfield recorded cannot be dropped by editing intent.md', () => {
  sdlc(repo, ['new', 'gf', '--type', 'greenfield', '--tier', 'S'])
  setIntent('gf', 'type: greenfield', 'type: chore')
  assert.match(sdlc(repo, ['status']).stdout, /gf\s+greenfield/)
})

test('approve tier refuses unless intent.md currently says exactly the stated tier and type, and records the stated values', () => {
  const human = { env: { SDLC_HUMAN: '1' } }
  setIntent('big', 'tier: L', 'tier: M')
  for (const args of [['S'], ['L'], ['M', 'chore'], ['X'], []]) {
    assert.notEqual(sdlc(repo, ['approve', 'big', 'tier', ...args], human).code, 0, args.join(' '))
    assert.equal(ratchetJson('big').tier, 'L')
  }
  assert.equal(sdlc(repo, ['approve', 'big', 'tier', 'M', 'feature'], human).code, 0)
  assert.deepEqual([ratchetJson('big').tier, ratchetJson('big').type], ['M', 'feature'])
})

test('with no recorded type, intent.md cannot pick a shorter path: the type is feature', () => {
  const r = ratchetJson('big')
  delete r.type
  fs.writeFileSync(path.join(repo, '.sdlc/changes/big/ratchet.json'), JSON.stringify(r))
  setIntent('big', 'type: feature', 'type: chore')
  assert.equal(status().step.verdict, 'human')
  assert.equal(status().step.node, 'design')
  assert.notEqual(preEdit('src/a.js'), 'allow')
  assert.match(sdlc(repo, ['status']).stdout, /type changed in intent\.md \(feature → chore\)/)
})
