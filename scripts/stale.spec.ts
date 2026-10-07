// status: stale artifacts by file time and tree stamp, open items, big slices, the three lines; approval refuses open intent questions.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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
  write(repo, '.sdlc/changes/feat/design.md', '## Files\n- src/a.ts\n')
  write(repo, '.sdlc/changes/feat/plan.md', '## Files\n- src/a.ts\n')
  touch('.sdlc/changes/feat/plan.md', 300)
  touch('.sdlc/changes/feat/design.md', 200)
  touch('.sdlc/changes/feat/intent.md', 100)
  const stale = status().stale as string[]
  assert.ok(stale.some(s => /feat: design\.md is older than intent\.md/.test(s)), stale.join('|'))
  assert.ok(stale.some(s => /feat: plan\.md is older than design\.md/.test(s)), stale.join('|'))
})

test('files with the same time are not stale (a fresh checkout stamps everything alike)', () => {
  write(repo, '.sdlc/changes/feat/design.md', '## Files\n- src/a.ts\n')
  for (const f of ['intent.md', 'design.md']) touch(`.sdlc/changes/feat/${f}`, 100)
  assert.deepEqual(status().stale, [])
})

test('a verification stamped on another tree is stale', () => {
  write(repo, '.sdlc/changes/feat/verification.md', '---\nresult: pass\ngenerated: sdlc\nruns: 1\ndigest: x\ntree: 0123456789abcdef\n---\n# Verification\n')
  assert.ok((status().stale as string[]).some(s => /feat: verification\.md was made on a different tree/.test(s)))
})

test('open questions in intent, design and plan are listed as open items', () => {
  write(repo, '.sdlc/changes/feat/intent.md', fs.readFileSync(path.join(repo, '.sdlc/changes/feat/intent.md'), 'utf8').replace('## Open questions\nnone', '## Open questions\n- Which provider do we use?'))
  write(repo, '.sdlc/changes/feat/design.md', '## Files\n- a\n## Open questions\n- Q1: cache TTL?\n')
  const open = status().open as string[]
  assert.ok(open.some(o => o.includes('feat/intent.md') && o.includes('Which provider')), open.join('|'))
  assert.ok(open.some(o => o.includes('feat/design.md') && o.includes('cache TTL')), open.join('|'))
})

test('a slice listing more than five files gets a warning, not a block', () => {
  write(repo, '.sdlc/changes/feat/plan.md', '## Files\n- a\n## Slices\n### Task 1: big\nFiles: `a.ts` `b.ts` `c.ts` `d.ts` `e.ts` `f.ts`\n')
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
  write(repo, '.sdlc/changes/feat/intent.md', fs.readFileSync(path.join(repo, '.sdlc/changes/feat/intent.md'), 'utf8').replace('## Open questions\nnone', '## Open questions\n- Which provider?'))
  write(repo, '.sdlc/changes/feat/design.md', '## Files\n- a\n## Open questions\nnone\n')
  const r = sdlc(repo, ['approve', 'feat', 'design'], { env: { SDLC_HUMAN: '1' } })
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /resolve the open question\(s\) in feat\/intent\.md/)
})
