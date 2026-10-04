import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnose, formatReport, LEARN, type ChangeEvidence } from './learn.ts'
import type { FileDiff } from './model.ts'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, write, gitIn, sdlc, hook } from './testkit.ts'

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

// A shipped change: one commit with the code, then one that adds ship.json (whose `base` is the commit before the code).
function seedShipped(repo: string, slug: string, o: { added: string[]; review?: string; ship?: unknown; events?: string; files?: Record<string, string> }): void {
  const base = gitIn(repo, 'rev-parse', 'HEAD')
  write(repo, `src/${slug}.js`, o.added.join('\n') + '\n')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', `feat ${slug}`)
  write(repo, `.sdlc/changes/${slug}/ship.json`, JSON.stringify(o.ship ?? { base }))
  if (o.review) write(repo, `.sdlc/changes/${slug}/review.md`, o.review)
  if (o.events) write(repo, `.sdlc/changes/${slug}/events.jsonl`, o.events)
  for (const [name, text] of Object.entries(o.files ?? {})) write(repo, `.sdlc/changes/${slug}/${name}`, text)
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', `ship ${slug}`)
}
const EVAL_REVIEW = '- [severity: high] [category: security] avoid `eval(` on user input\n'
const learnRepo = (evalChanges: number, cleanChanges: number): string => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  for (let i = 1; i <= evalChanges; i++) seedShipped(repo, `bad-${i}`, { added: ['const x = eval(input)'], review: EVAL_REVIEW })
  for (let i = 1; i <= cleanChanges; i++) seedShipped(repo, `ok-${i}`, { added: ['const x = 1'] })
  return repo
}

test('learn finds a recurring review token, proves it on the stored diffs and writes proposals.json', () => {
  const repo = learnRepo(3, 7)
  const r = sdlc(repo, ['learn'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /10 shipped change\(s\), 10 with a rebuilt diff/)
  assert.match(r.stdout, /learned-security \[rule-add, risk low\] replay pass/)
  const file = path.join(repo, '.sdlc/learn/proposals.json')
  const first = fs.readFileSync(file, 'utf8')
  assert.equal(JSON.parse(first).proposals[0].edit.pattern, 'eval\\(')
  sdlc(repo, ['learn'])
  assert.equal(fs.readFileSync(file, 'utf8'), first)
  assert.equal(gitIn(repo, 'status', '--porcelain', '--', '.sdlc/learn'), '')
  assert.match(sdlc(repo, ['learn', 'show']).stdout, /learned-security/)
})

test('findings in review-slice-N.md and review-pr.md count when review.md is missing, de-duplicated per change', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  for (let i = 1; i <= 3; i++) seedShipped(repo, `bad-${i}`, { added: ['const x = eval(input)'], files: { 'review-slice-1.md': `verdict: changes-needed\n${EVAL_REVIEW}`, 'review-pr.md': `verdict: pass\n${EVAL_REVIEW}` } })
  for (let i = 1; i <= 7; i++) seedShipped(repo, `ok-${i}`, { added: ['const x = 1'] })
  const r = sdlc(repo, ['learn'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /learned-security \[rule-add, risk low\] replay pass/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/learn/proposals.json'), 'utf8')).proposals[0].evidence, ['bad-1', 'bad-2', 'bad-3'])
})

test('with fewer than ten shipped changes the proposal is listed but not promotable', () => {
  const repo = learnRepo(3, 2)
  assert.match(sdlc(repo, ['learn']).stdout, /replay insufficient-holdout/)
  assert.match(sdlc(repo, ['learn', '--min-changes', '5']).stdout, /replay pass/)
})

test('a repo with no shipped change says so and exits 0', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  const r = sdlc(repo, ['learn'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /0 shipped change\(s\)/)
})

test('a change with no usable base, a gone commit, or malformed evidence is skipped, never a crash', () => {
  const repo = learnRepo(0, 0)
  seedShipped(repo, 'no-base', { added: ['x'], ship: {} })
  seedShipped(repo, 'gone-base', { added: ['x'], ship: { base: '0000000000000000000000000000000000000000' } })
  seedShipped(repo, 'garbled', { added: ['x'], review: '- [severity: high [category: oops\n\0', events: '{not json\n' })
  const r = sdlc(repo, ['learn'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /skipped: gone-base, no-base/)
  assert.doesNotMatch(r.stdout, /garbled/)
})

test('a regex-metacharacter token is escaped into a valid pattern', () => {
  const repo = makeRepo()
  sdlc(repo, ['init'])
  for (const s of ['a', 'b']) seedShipped(repo, `m-${s}`, { added: ['run(a+b)[0]'], review: '- [severity: high] [category: style] never write `run(a+b)[0]`\n' })
  const p = JSON.parse((sdlc(repo, ['learn', '--min-changes', '2']), fs.readFileSync(path.join(repo, '.sdlc/learn/proposals.json'), 'utf8'))).proposals[0]
  assert.equal(p.edit.pattern, 'run\\(a\\+b\\)\\[0\\]')
  assert.equal(p.replay.status, 'pass')
})

test('the model cannot write proposals.json', () => {
  const repo = learnRepo(0, 0)
  const edit = JSON.parse(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(repo, '.sdlc/learn/proposals.json') } }).stdout)
  assert.equal(edit.hookSpecificOutput.permissionDecision, 'deny')
  const bash = JSON.parse(hook(repo, 'pre-bash', { tool_input: { command: `echo '{}' > .sdlc/learn/proposals.json` } }).stdout)
  assert.equal(bash.hookSpecificOutput.permissionDecision, 'deny')
})

const HUMAN = { env: { SDLC_HUMAN: '1' } }

test('approve learn promotes a passing rule-add into rules.json as a warn rule, for a person only', () => {
  const repo = learnRepo(3, 7)
  sdlc(repo, ['learn'])
  const model = sdlc(repo, ['approve', 'learned-security', 'learn'])
  assert.equal(model.code, 3)
  assert.equal(fs.existsSync(path.join(repo, '.sdlc/rules.json')), false)
  const r = sdlc(repo, ['approve', 'learned-security', 'learn'], HUMAN)
  assert.equal(r.code, 0, r.stderr)
  const rules = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/rules.json'), 'utf8'))
  assert.equal(rules.length, 1)
  assert.deepEqual([rules[0].id, rules[0].action, rules[0].pattern], ['learned-security', 'warn', 'eval\\('])
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/.gate'), 'utf8'), /\.sdlc\/rules\.json/)
  const again = sdlc(repo, ['approve', 'learned-security', 'learn'], HUMAN)
  assert.equal(again.code, 1)
  assert.match(again.stderr, /no longer recurs|no proposal/)
})

test('approve learn refuses an insufficient holdout, an unknown id and an advisory sensor-tune', () => {
  const repo = learnRepo(3, 2)
  sdlc(repo, ['learn'])
  assert.match(sdlc(repo, ['approve', 'learned-security', 'learn'], HUMAN).stderr, /replay is insufficient-holdout/)
  assert.match(sdlc(repo, ['approve', 'nope-nope', 'learn'], HUMAN).stderr, /no proposal nope-nope/)
  const tune = learnRepo(0, 0)
  for (const s of ['a', 'b']) {
    seedShipped(tune, `w-${s}`, { added: ['x'] })
    fs.appendFileSync(path.join(tune, '.sdlc/waivers.jsonl'), JSON.stringify({ slug: `w-${s}`, sensor: 'size', file: 'src/big/a.js', reason: 'generated', by: 't', at: 'now' }) + '\n')
  }
  sdlc(tune, ['learn', '--min-changes', '2'])
  assert.match(sdlc(tune, ['approve', 'tune-size-src-big', 'learn'], HUMAN).stderr, /advisory/)
})

test('approve learn re-runs the gate: a later clean change that trips the rule makes the proposal stale', () => {
  const repo = learnRepo(3, 7)
  sdlc(repo, ['learn'])
  seedShipped(repo, 'late', { added: ['const z = eval(other)'] })
  const r = sdlc(repo, ['approve', 'learned-security', 'learn'], HUMAN)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /replay is fail/)
  assert.equal(fs.existsSync(path.join(repo, '.sdlc/rules.json')), false)
})

test('approve learn promotes the freshly derived rule, not a forged proposals.json', () => {
  const repo = learnRepo(3, 7)
  sdlc(repo, ['learn'])
  const file = path.join(repo, '.sdlc/learn/proposals.json')
  const forged = JSON.parse(fs.readFileSync(file, 'utf8'))
  forged.proposals[0].edit.pattern = '.*'
  forged.proposals[0].edit.action = 'block'
  fs.writeFileSync(file, JSON.stringify(forged))
  assert.equal(sdlc(repo, ['approve', 'learned-security', 'learn'], HUMAN).code, 0)
  const rule = JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/rules.json'), 'utf8'))[0]
  assert.deepEqual([rule.pattern, rule.action], ['eval\\(', 'warn'])
})
