// status: stale artifacts by file time and tree stamp, open items, big slices, the three lines; approval refuses open intent questions.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'
import { sliceFiles } from './slices.ts'

let repo: string
beforeEach(() => { repo = makeRepo(); sdlc(repo, ['new', 'feat', '--type', 'feature', '--tier', 'M']) })
const touch = (rel: string, secondsAgo: number): void => { const t = new Date(Date.now() - secondsAgo * 1000); fs.utimesSync(path.join(repo, rel), t, t) }
const status = () => JSON.parse(sdlc(repo, ['status', '--json']).stdout)

test('sliceFiles reads the paths on each slice Files line', () => {
  const plan = '## Slices\n### Task 1: a\nFiles: `src/a.ts`, `src/b.ts`\nGoal.\n### Task 2: b\n- **Files:** `src/c.ts`\n### Task 3: none\nno files line\n'
  assert.deepEqual(sliceFiles(plan), { '1': ['src/a.ts', 'src/b.ts'], '2': ['src/c.ts'], '3': [] })
})

test('design older than intent, and plan older than design, are stale', () => {
  write(repo, '.rig/changes/feat/design.md', '## Files\n- src/a.ts\n')
  write(repo, '.rig/changes/feat/plan.md', '## Files\n- src/a.ts\n')
  touch('.rig/changes/feat/plan.md', 300)
  touch('.rig/changes/feat/design.md', 200)
  touch('.rig/changes/feat/intent.md', 100)
  const stale = status().stale as string[]
  assert.ok(stale.some(s => /feat: design\.md is older than intent\.md/.test(s)), stale.join('|'))
  assert.ok(stale.some(s => /feat: plan\.md is older than design\.md/.test(s)), stale.join('|'))
})

test('files with the same time are not stale (a fresh checkout stamps everything alike)', () => {
  write(repo, '.rig/changes/feat/design.md', '## Files\n- src/a.ts\n')
  for (const f of ['intent.md', 'design.md']) touch(`.rig/changes/feat/${f}`, 100)
  assert.deepEqual(status().stale, [])
})

test('a verification stamped on another tree is stale', () => {
  write(repo, '.rig/changes/feat/verification.md', '---\nresult: pass\ngenerated: sdlc\nruns: 1\ndigest: x\ntree: 0123456789abcdef\n---\n# Verification\n')
  assert.ok((status().stale as string[]).some(s => /feat: verification\.md was made on a different tree/.test(s)))
})

test('open questions in intent, design and plan are listed as open items', () => {
  write(repo, '.rig/changes/feat/intent.md', fs.readFileSync(path.join(repo, '.rig/changes/feat/intent.md'), 'utf8').replace('## Open questions\nnone', '## Open questions\n- Which provider do we use?'))
  write(repo, '.rig/changes/feat/design.md', '## Files\n- a\n## Open questions\n- Q1: cache TTL?\n')
  const open = status().open as string[]
  assert.ok(open.some(o => o.includes('feat/intent.md') && o.includes('Which provider')), open.join('|'))
  assert.ok(open.some(o => o.includes('feat/design.md') && o.includes('cache TTL')), open.join('|'))
})

test('a slice listing more than five files gets a warning, not a block', () => {
  write(repo, '.rig/changes/feat/plan.md', '## Files\n- a\n## Slices\n### Task 1: big\nFiles: `a.ts` `b.ts` `c.ts` `d.ts` `e.ts` `f.ts`\n')
  const out = sdlc(repo, ['status']).stdout
  assert.match(out, /warn: feat: slice 1 lists 6 files \(limit 5\)/)
})

test('text status ends with where, stale and next lines', () => {
  const out = sdlc(repo, ['status']).stdout
  assert.match(out, /^where: feat is at \w+/m)
  assert.match(out, /^stale: nothing$/m)
  assert.match(out, /^next: /m)
})

test('approving a design is refused while intent.md has an open question', () => {
  write(repo, '.rig/changes/feat/intent.md', fs.readFileSync(path.join(repo, '.rig/changes/feat/intent.md'), 'utf8').replace('## Open questions\nnone', '## Open questions\n- Which provider?'))
  write(repo, '.rig/changes/feat/design.md', '## Files\n- a\n## Open questions\nnone\n')
  const r = sdlc(repo, ['approve', 'feat', 'design'], { env: { SDLC_HUMAN: '1' } })
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /resolve the open question\(s\) in feat\/intent\.md/)
})

test('a shipped change is never stale; the same data on an unshipped one is', () => {
  const data = (slug: string): void => {
    write(repo, `.rig/changes/${slug}/intent.md`, '# i\n')
    write(repo, `.rig/changes/${slug}/design.md`, '## Files\n- a\n')
    write(repo, `.rig/changes/${slug}/verification.md`, '---\nresult: pass\ngenerated: sdlc\nruns: 1\ndigest: x\ntree: 0123456789abcdef\n---\n')
    touch(`.rig/changes/${slug}/design.md`, 200)
    touch(`.rig/changes/${slug}/intent.md`, 100)
  }
  data('old'); data('live')
  write(repo, '.rig/changes/old/ship.json', '{}\n')
  gitIn(repo, 'add', '.rig/changes/old/ship.json'); gitIn(repo, 'commit', '-qm', 'ship old')
  const stale = status().stale as string[]
  assert.ok(stale.some(s => s.startsWith('live: ')), stale.join('|'))
  assert.ok(!stale.some(s => s.startsWith('old: ')), stale.join('|'))
})

test('three unshipped changes with stamped verifications are all flagged', () => {
  for (const s of ['bb', 'cc']) sdlc(repo, ['new', s, '--type', 'feature', '--tier', 'M'])
  for (const s of ['feat', 'bb', 'cc']) write(repo, `.rig/changes/${s}/verification.md`, '---\nresult: pass\ngenerated: sdlc\nruns: 1\ndigest: x\ntree: 0123456789abcdef\n---\n')
  const stale = status().stale as string[]
  for (const s of ['feat', 'bb', 'cc']) assert.ok(stale.some(x => x.startsWith(`${s}: verification.md was made`)), stale.join('|'))
})

test('staleness uses a passed tree stamp instead of computing one', () => {
  write(repo, '.rig/changes/feat/verification.md', '---\nresult: pass\ngenerated: sdlc\nruns: 1\ndigest: x\ntree: abc\n---\n')
  const run = (tree: string): string => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e',
    `import('${path.resolve(import.meta.dirname, 'stale.ts')}').then(m => console.log(JSON.stringify(m.staleness('feat', '${tree}'))))`], { cwd: repo, encoding: 'utf8', env: { ...process.env, SDLC_ROOT: repo } }).trim()
  assert.deepEqual(JSON.parse(run('abc')), [])
  assert.match(run('zzz'), /verification\.md was made on a different tree/)
})

test('sliceFiles reads bulleted Files lists, merges inline ones, and stops at a non-bullet', () => {
  const plan = '### Task 1: a\n**Files:**\n- `a.ts` (new)\n* `b.ts`\n\n- `not.ts`\n### Task 2: b\nFiles: `x.ts`\n- `y.ts`\n### Task 3: c\nFiles:\nSome paragraph with `z.ts`.\n'
  assert.deepEqual(sliceFiles(plan), { '1': ['a.ts', 'b.ts'], '2': ['x.ts', 'y.ts'], '3': [] })
})

test('a six-bullet slice gets the warning', () => {
  write(repo, '.rig/changes/feat/plan.md', '## Files\n- a\n## Slices\n### Task 1: big\nFiles:\n' + 'abcdef'.split('').map(c => `- \`${c}.ts\`\n`).join(''))
  assert.match(sdlc(repo, ['status']).stdout, /warn: feat: slice 1 lists 6 files/)
})
