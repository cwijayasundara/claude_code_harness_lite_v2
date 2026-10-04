import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnose, formatReport, LEARN, type ChangeEvidence } from './learn.ts'
import type { FileDiff } from './model.ts'

const fd = (file: string, lines: string[]): FileDiff => ({ file, status: 'M', added: lines.map((text, i) => ({ n: i + 1, text })), removed: [] })
const finding = (text: string, category = 'security') => ({ severity: 'high', category, text })
const ev = (slug: string, o: Partial<ChangeEvidence> = {}): ChangeEvidence => ({ slug, findings: [], waivers: [], blockedReasons: [], diffs: [], rebuilt: true, ...o })
const evalChange = (slug: string): ChangeEvidence => ev(slug, { findings: [finding('avoid `eval(` on user input')], diffs: [fd(`src/${slug}.js`, ['const x = eval(input)'])] })
const clean = (slug: string): ChangeEvidence => ev(slug, { diffs: [fd(`src/${slug}.js`, ['const x = 1'])] })

test('a finding token that recurs in three changes becomes one escaped, passing rule', () => {
  const r = diagnose([evalChange('a'), evalChange('b'), evalChange('c'), clean('d'), clean('e')], [], 3)
  assert.equal(r.proposals.length, 1)
  const p = r.proposals[0]
  assert.ok(p && p.kind === 'rule-add')
  assert.equal(p.id, 'learned-security')
  assert.equal(p.edit.pattern, 'eval\\(')
  assert.equal(p.edit.action, 'warn')
  assert.match(p.edit.why, /a, b, c/)
  assert.doesNotThrow(() => new RegExp(p.edit.pattern))
  assert.equal(p.replay.status, 'pass')
  assert.deepEqual(p.replay.firedOn, ['a', 'b', 'c'])
})

test('a candidate that also fires on a change with no such finding fails the gate', () => {
  const noisy = ev('d', { diffs: [fd('src/d.js', ['const y = eval(other)'])] })
  const r = diagnose([evalChange('a'), evalChange('b'), noisy], [], 3)
  assert.equal(r.proposals[0]?.replay.status, 'fail')
  assert.deepEqual(r.proposals[0]?.replay.falsePositives, ['d'])
})

test('a candidate whose token never appears in the stored diffs fails the gate', () => {
  const prose = (slug: string) => ev(slug, { findings: [finding('avoid `eval(` on user input')], diffs: [fd(`src/${slug}.js`, ['const x = 1'])] })
  const r = diagnose([prose('a'), prose('b'), clean('c')], [], 3)
  assert.equal(r.proposals[0]?.replay.status, 'fail')
  assert.match(r.proposals[0]?.replay.reason ?? '', /fires on none/)
})

test('fewer shipped changes than the minimum marks proposals insufficient-holdout', () => {
  const r = diagnose([evalChange('a'), evalChange('b'), clean('c')], [])
  assert.equal(LEARN.minChanges, 10)
  assert.equal(r.proposals[0]?.replay.status, 'insufficient-holdout')
})

test('a token seen in only one change, or an existing rule id, proposes nothing', () => {
  assert.equal(diagnose([evalChange('a'), clean('b'), clean('c')], [], 3).proposals.length, 0)
  assert.equal(diagnose([evalChange('a'), evalChange('b'), clean('c')], ['learned-security'], 3).proposals.length, 0)
})

test('waiver churn across two changes is one advisory sensor-tune, and one change is nothing', () => {
  const waived = (slug: string) => ev(slug, { waivers: [{ sensor: 'size', file: 'src/big/a.js', reason: 'generated' }] })
  const r = diagnose([waived('a'), waived('b'), clean('c')], [], 3)
  const p = r.proposals[0]
  assert.ok(p && p.kind === 'sensor-tune')
  assert.equal(p.id, 'tune-size-src-big')
  assert.equal(p.edit.files, 'src/big/**')
  assert.equal(p.replay.status, 'not-applicable')
  assert.equal(diagnose([waived('a'), clean('b'), clean('c')], [], 3).proposals.length, 0)
})

test('changes without a rebuilt diff are skipped and listed, and cap or stall blocks become a note', () => {
  const gone = ev('gone', { rebuilt: false, blockedReasons: ['cap: 2 fix rounds used and 1 finding(s) remain'] })
  const stalled = ev('stalled', { blockedReasons: ['stall: the same finding came back after a fix round'] })
  const r = diagnose([gone, stalled, clean('c')], [], 2)
  assert.deepEqual(r.skipped, ['gone'])
  assert.equal(r.rebuilt, 2)
  assert.match(r.notes.join('\n'), /2 change\(s\) hit a cap or stall: gone, stalled/)
})

test('the report does not depend on the order the changes arrive in', () => {
  const corpus = [evalChange('a'), evalChange('b'), clean('c'), clean('d')]
  assert.equal(JSON.stringify(diagnose(corpus, [], 3)), JSON.stringify(diagnose([...corpus].reverse(), [], 3)))
})

test('formatReport names each proposal with its replay status and the promote command', () => {
  const text = formatReport(diagnose([evalChange('a'), evalChange('b'), clean('c')], [], 3))
  assert.match(text, /learned-security \[rule-add, risk low\] replay pass/)
  assert.match(text, /\/rig-approve <id> learn/)
  assert.match(formatReport(diagnose([], [])), /0 shipped change\(s\)/)
})
