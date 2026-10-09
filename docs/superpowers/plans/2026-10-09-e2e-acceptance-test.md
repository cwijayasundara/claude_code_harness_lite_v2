# E2E Acceptance Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended here: the tasks share interfaces) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `npm run test:e2e` (real Claude Code, `claude -p`) scaffolds a throwaway project, installs the harness into it, and drives the whole rig lifecycle (greenfield cart to PR, a small change to PR, deploy gate, maintain loop) with the human gates approved in code and every artifact asserted.

**Architecture:** One `Phase` description per lifecycle phase; one **operator** loop that reads `sdlc.ts next --json`, approves expected gates, and asks a **driver** to do each work node. **The acceptance test is the live driver: the real Claude Code CLI (`claude -p`) running the vendored `/rig-*` skills and agents with the real model.** The scripted driver (a fake model replaying fixture files, $0) is a fast pre-flight that proves the operator, the assertions and the harness scripts before any money is spent; it never counts as the acceptance result. Both feed the existing M1 assertion library (`tests/integration/assert/*`, `acceptance/cart.mjs`).

**Tech Stack:** Node >= 22.18 ESM `.mjs`, `node:test`, no new runtime deps. One devDependency, `yaml`, for the workflow lint in Task 5.

**Spec:** `docs/superpowers/specs/2026-10-09-e2e-acceptance-test-design.md`

## Global Constraints

- All new code lives under `tests/e2e/`; M1 modules in `tests/integration/` are imported, not edited, except where a task says so.
- The project under test is a `mkdtemp` sandbox (`createSandbox` from `tests/integration/lib/sandbox.mjs`). Nothing in this plan runs rig on this repo's own tree (CLAUDE.md).
- Operator identity string is `operator`; every approval row must carry `by: operator`.
- Gates are approved with `sb.sdlc(['approve', slug, gate, '--by', 'operator'], { human: true })`, the gate name read from `status --json` `changes[].next.gate`, never parsed from prose.
- Scripted driver: no network, no clock dependence, cart has zero dependencies, tests run with `node --test`.
- Every new assertion has a seeded-bad twin that must fail it (Task 6).
- Per CLAUDE.md: run `npm test` yourself and quote the output; one review of `git diff main...HEAD` at the end; at most one Sonnet implementer per independent file group.

## Review Focus

1. A skill's node order differs from the scripted handlers (the fake drifts from the real skills): the operator's no-progress guard must fail loudly, never loop (Task 1 test).
2. A gate the path does not have is approved, or a needed one is skipped: operator must fail on an unexpected gate (Task 1 test).
3. `gates.jsonl` is gitignored and absent when `.sdlc/` is missing: the production-gate assertion must create the dir first (Task 5).
4. A `breach` intent file is only written for tier 2+; in-band values must write none (Task 6).
5. A stale approval (design edited after approval) must be reported by `next`, not silently accepted (Task 4).

## Facts verified against the repo (read, do not re-derive)

- `sdlc.ts next [slug] --json` returns `{slug, node, verdict: 'continue'|'human'|'blocked'|'ready', reason, command, round, ...}`; `status --json` has `changes[].next = {stage, kind: 'approve'|'work', state, gate}`.
- `new <slug> --type greenfield|feature|incident ... --tier S|M|L` creates the change; a greenfield tier M change starts at node `design` and its only gate there is `design`.
- Route (selftest `shipBestsellers`): write `design.md` -> `approve ... design` -> red `run --expect-fail` -> impl -> green `run` -> `ratchet record <slug> build --slice N --checks` -> `verify` -> `quality` -> `pr --message` -> write `review-pr.md` + `review.md` -> `ratchet record <slug> pr-review --from <file>` -> `pr-checks`.
- Incident path stages: `intent, plan(L only), diagnose, test, sensors, pr, pr-review`.
- `metrics` keys: `repeat_incident_share`, `time_to_restore_hours`, `breach_to_intent_hours`, `rollback_rehearsal_success` (the last needs `gh`; with the stub it reports the needs-gh state, so P3 asserts the rehearsal command runs, not the metric. This corrects the spec).
- Bands: `.sdlc/sensors.json` `bands: [{id, query, window>=5, step, minSd, tools, routes}]`; `watch --json` returns `[{id, tier, value, rule, breach}]`; `MIN_SAMPLE` is 5 and the last 8 points are excluded from the baseline, so a breach needs >= 13 points.
- `.sdlc/gates.jsonl` is gitignored; `production-gate.sh` appends `{at, decision, session}` only if `$CLAUDE_PROJECT_DIR/.sdlc` exists.

## Execution order and the real-Claude requirement

Do **Task 8 (live driver) immediately after Task 2**, not last. Task 2 proves the operator and assertions with the fake model; Task 8 then proves P0 and P1 with real Claude Code before any further phase is built, so fixtures and handlers in Tasks 4 to 6 are written against what the real skills actually do, and each later phase gets a live run when it lands. Task 7 wires only `test:e2e:fast` and `test:e2e:unit` into `npm test` and CI (CI has no Claude credentials or budget); `npm run test:e2e` is run by a person before a release, and its report is the acceptance evidence. Preconditions: `claude` on PATH and logged in, a hard `--cap` (default $6 per run; start at P0+P1 only), and two runs before a release since model output varies.

## File Structure

```
tests/e2e/
  run.mjs                 entry: --driver scripted|live, --phase P0..P4, --keep, --out
  lib/operator.mjs        runRoute(): the gate-driving loop
  lib/operator.test.mjs   unit tests for the loop against a fake sandbox
  lib/merge.mjs           mergeToMain(sb, slug): the operator plays the merger
  lib/report.mjs          writeReport(out, results)
  driver/scripted.mjs     scriptedDriver(sb, phase) -> { begin, step }
  driver/live.mjs         liveDriver(sb, phase, opts) -> { begin, step, sessions }
  phases/p0-install.mjs   install()
  phases/p1-greenfield.mjs  PHASE + run()
  phases/p2-change.mjs      PHASE + run()
  phases/p3-deploy.mjs      run()
  phases/p4-maintain.mjs    PHASE + run()
  assert/deploy.mjs       assertProductionGate, assertRollbackRehearsal, assertWorkflows
  assert/maintain.mjs     assertWatch, assertIncident
  negative.mjs            seeded-bad twins for the new assertions
  prd/cart.md             the PRD
  fixtures/p1/{src/cart.js,test/cart.test.js}
  fixtures/p2/{src/cart.js,test/coupon.test.js}
  fixtures/p4/{src/cart.js,test/regression.test.js}
```

---

### Task 1: The operator loop

**Files:**
- Create: `tests/e2e/lib/operator.mjs`, `tests/e2e/lib/operator.test.mjs`, `tests/e2e/lib/merge.mjs`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces: `runRoute({ sb, slug, driver, operator = 'operator', maxSteps = 10, expectGates }) -> Promise<{ steps: number, approved: string[], end: 'ready'|'done' }>`. `driver.step(node, { slug, round })` does one work node and may throw. `expectGates(slug)` returns the allowed gate names (default: accept any gate named in `status`).
- Produces: `mergeToMain(sb, slug)`: pushes `HEAD:refs/heads/prepush-<slug>` (so pre-push runs), checks out `main`, `merge --ff-only sdlc/<slug>`.

- [ ] **Step 1: Write the failing tests** (`tests/e2e/lib/operator.test.mjs`)

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { runRoute } from './operator.mjs'

// A fake sandbox: sdlc() answers from a queue of canned replies keyed by subcommand.
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/e2e/lib/operator.test.mjs`
Expected: FAIL, `Cannot find module './operator.mjs'`.

- [ ] **Step 3: Implement** (`tests/e2e/lib/operator.mjs`)

```js
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
```

`tests/e2e/lib/merge.mjs`:

```js
// The operator plays the merger: push to a fresh ref so pre-push really runs, then fast-forward main.
export function mergeToMain(sb, slug) {
  sb.git('push', 'origin', `HEAD:refs/heads/prepush-${slug}`)
  sb.git('checkout', '-q', 'main')
  sb.git('merge', '-q', '--ff-only', `sdlc/${slug}`)
}
```

Add to `package.json` scripts: `"test:e2e": "node tests/e2e/run.mjs --driver live"` (the acceptance test: real Claude Code, costs money, capped), `"test:e2e:fast": "node tests/e2e/run.mjs --driver scripted"` (fake model, $0, pre-flight only), `"test:e2e:unit": "node --test tests/e2e/lib/*.test.mjs"`. In Tasks 2 to 7 read `npm run test:e2e` as `npm run test:e2e:fast` until Task 8 lands.

- [ ] **Step 4: Run to verify pass**

Run: `npm run test:e2e:unit`
Expected: 6 tests pass.

- [ ] **Step 5: Commit** (on a branch `feat/e2e-acceptance`; create it first with `git checkout -b feat/e2e-acceptance`)

```bash
git add tests/e2e package.json
git commit -m "test(e2e): operator loop that plays the human at every gate"
```

---

### Task 2: PRD, P0 install, P1 greenfield (scripted)

**Files:**
- Create: `tests/e2e/prd/cart.md`, `tests/e2e/fixtures/p1/src/cart.js`, `tests/e2e/fixtures/p1/test/cart.test.js`, `tests/e2e/phases/p0-install.mjs`, `tests/e2e/phases/p1-greenfield.mjs`, `tests/e2e/driver/scripted.mjs`, `tests/e2e/lib/report.mjs`, `tests/e2e/run.mjs`

**Interfaces:**
- Consumes: `runRoute`, `createSandbox`, `Checks`, `assertOnboarding(c, sb, {lane:'greenfield'})`, `assertChange(c, sb, slug, {operator, label})`, `assertCart(c, repo, 'cart')`, `assertPrePushPasses`, `assertPreCommitRefusesSecret`.
- Produces: `install(sb)` (P0); `PHASE` objects `{ id, slug, type, tier, title, intent, design, tests: [{src,dest}], impl: [{src,dest}], commit, acceptance }`; `scriptedDriver(sb, phase) -> { begin(): slug, step(node, ctx) }`; `writeReport(out, checksList)`; the `run.mjs` CLI.

- [ ] **Step 1: Write the PRD** `tests/e2e/prd/cart.md`

```markdown
# PRD: shopping cart library

Build a Node.js 22 ESM library, no dependencies, tests with `node --test`: an in-memory shopping cart.

- `Cart.add(sku, priceCents, qty = 1)`: a repeat add of the same SKU sums the quantity.
- `Cart.remove(sku)`: deletes the whole line; throws `Error` for a SKU not in the cart.
- `Cart.lines()`: `[{ sku, qty, priceCents }]` sorted by sku ascending.
- `Cart.totalCents()`: sum of `priceCents * qty`.
- `qty` must be a positive integer and `priceCents` a non-negative integer, otherwise `add` throws `RangeError`.
- This is the library's first public API. Include tests.
```

- [ ] **Step 2: Write fixtures.** `tests/e2e/fixtures/p1/src/cart.js`:

```js
export class Cart {
  #lines = new Map()

  add(sku, priceCents, qty = 1) {
    if (!Number.isInteger(qty) || qty <= 0) throw new RangeError('qty must be a positive integer')
    if (!Number.isInteger(priceCents) || priceCents < 0) throw new RangeError('priceCents must be a non-negative integer')
    const line = this.#lines.get(sku)
    this.#lines.set(sku, { sku, priceCents, qty: (line?.qty ?? 0) + qty })
  }

  remove(sku) {
    if (!this.#lines.delete(sku)) throw new Error(`not in cart: ${sku}`)
  }

  lines() {
    return [...this.#lines.values()].sort((a, b) => (a.sku < b.sku ? -1 : 1)).map(l => ({ ...l }))
  }

  totalCents() {
    return this.lines().reduce((n, l) => n + l.priceCents * l.qty, 0)
  }
}
```

`tests/e2e/fixtures/p1/test/cart.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { Cart } from '../src/cart.js'

test('repeat add sums qty and lines are sorted by sku', () => {
  const c = new Cart()
  c.add('B', 200)
  c.add('A', 100, 2)
  c.add('A', 100)
  assert.deepEqual(c.lines(), [{ sku: 'A', qty: 3, priceCents: 100 }, { sku: 'B', qty: 1, priceCents: 200 }])
  assert.equal(c.totalCents(), 500)
})

test('remove deletes the line and throws for an unknown sku', () => {
  const c = new Cart()
  c.add('A', 100)
  c.remove('A')
  assert.equal(c.lines().length, 0)
  assert.throws(() => c.remove('A'), Error)
})

test('add rejects bad qty and price with RangeError', () => {
  const c = new Cart()
  assert.throws(() => c.add('A', 100, 0), RangeError)
  assert.throws(() => c.add('A', 100, 1.5), RangeError)
  assert.throws(() => c.add('A', -1), RangeError)
})
```

- [ ] **Step 3: Write P0** `tests/e2e/phases/p0-install.mjs`

```js
import { Checks } from '../../integration/lib/checks.mjs'
import { assertOnboarding } from '../../integration/assert/onboarding.mjs'

export const ROUTING = 'sdlc routes all work in this repo: start with /rig-start; use superpowers skills only when an sdlc skill names one.'

const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' | ')}`)
  return r.stdout
}

// What the standalone install does, via the harness's own commands (the live driver instead runs /rig:init with --plugin-dir).
export async function install(sb) {
  sb.isolate([])
  const scripts = { test: 'node --test', 'test-fast': 'node --test', lint: 'node --check src/index.js' }
  sb.write('package.json', JSON.stringify({ name: 'cart', version: '0.1.0', type: 'module', scripts }, null, 2) + '\n')
  sb.write('src/index.js', 'export {}\n')
  sb.write('test/smoke.test.js', "import { test } from 'node:test'\nimport '../src/index.js'\ntest('loads', () => {})\n")
  sb.commitAll('chore: scaffold')
  must(sb.sdlc(['init']), 'init')
  sb.write('.sdlc/sensors.json', JSON.stringify({ fast: { test: 'npm test' }, full: { test: 'npm test' } }, null, 2) + '\n')
  must(sb.sdlc(['init', '--stack']), 'init --stack')
  must(sb.sdlc(['init', '--full']), 'init --full')
  sb.write('CLAUDE.md', `# cart\n\n${ROUTING}\n\n## Map\n- src/\n`)
  sb.commitAll('chore: onboard rig')
  must(sb.sdlc(['preflight', '--answers', '{"gates":"default","valueRate":"100","consumers":"none"}']), 'preflight')
  sb.commitAll('chore: preflight report')
  const c = new Checks('P0 install')
  await assertOnboarding(c, sb, { lane: 'greenfield' })
  return c
}
```

- [ ] **Step 4: Write P1 + scripted driver.** `tests/e2e/phases/p1-greenfield.mjs`:

```js
import fs from 'node:fs'
import path from 'node:path'
import { Checks } from '../../integration/lib/checks.mjs'
import { assertChange } from '../../integration/assert/change.mjs'
import { assertPrePushPasses, assertPreCommitRefusesSecret } from '../../integration/assert/hooks.mjs'
import { assertCart } from '../../integration/acceptance/cart.mjs'
import { runRoute } from '../lib/operator.mjs'

const fx = rel => path.join(import.meta.dirname, '../fixtures/p1', rel)
export const PRD = fs.readFileSync(path.join(import.meta.dirname, '../prd/cart.md'), 'utf8')

export const PHASE = {
  id: 'P1', slug: 'cart', type: 'greenfield', tier: 'M', title: 'Shopping cart library',
  prompt: `/rig-start ${PRD.replace(/\n+/g, ' ')}`,
  intent: {
    problem: 'There is no cart library yet; shops need an in-memory cart with exact integer-cent totals.',
    outcome: 'Cart add/remove/lines/totalCents behave per the PRD; node --test passes.',
    nonGoals: 'Coupons, discounts, persistence.',
    risks: 'none: first public API, so names are the contract.',
  },
  design: [
    '# Cart', '', '## Contracts', '- `Cart` exported from src/cart.js: add, remove, lines, totalCents.', '',
    '## Files', '- src/cart.js', '- test/cart.test.js', '',
    '## Slices', '1. Cart: add/remove/lines/totalCents (test/cart.test.js)', '',
    '## Verification', '- npm test', '',
  ].join('\n'),
  tests: [{ src: fx('test/cart.test.js'), dest: 'test/cart.test.js' }],
  impl: [{ src: fx('src/cart.js'), dest: 'src/cart.js' }],
  commit: 'feat(cart): add the Cart class',
  acceptance: 'cart',
}

// Runs one change through the route and asserts it. `driver` is scripted or live.
export async function runChange(sb, phase, driver, { operator = 'operator', first = false } = {}) {
  const slug = await driver.begin()
  const route = await runRoute({ sb, slug, driver })
  const c = new Checks(`${phase.id} ${phase.title}`)
  await assertChange(c, sb, slug, { operator, label: slug })
  await c.check(`${phase.id}: approved at least one gate`, () => route.approved.length > 0 || 'no human gate was approved')
  if (first) {
    await assertPrePushPasses(c, sb, slug)
    await assertPreCommitRefusesSecret(c, sb)
  }
  await assertCart(c, sb.dir, phase.acceptance)
  return { slug, route, checks: c }
}
```

`tests/e2e/driver/scripted.mjs`:

```js
// The fake model: plays each work node the way the skills do, from the phase's fixture files.
import fs from 'node:fs'

const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' | ')}`)
  return r.stdout
}
const intentMd = (sb, slug, p) => {
  const cur = sb.read(`.sdlc/changes/${slug}/intent.md`)
  const head = /^---\n[\s\S]*?\n---\n/.exec(cur)[0]
  return `${head}# ${p.title}\n\n## Problem\n${p.intent.problem}\n\n## Outcome\n${p.intent.outcome}\n\n## Non-goals\n${p.intent.nonGoals}\n\n## Risks\n${p.intent.risks}\n\n## Decisions\nnone\n\n## Open questions\nnone\n`
}
const copy = (sb, files) => files.forEach(f => { fs.mkdirSync(sb.file(f.dest).replace(/[^/]*$/, ''), { recursive: true }); fs.copyFileSync(f.src, sb.file(f.dest)) })

export function scriptedDriver(sb, phase) {
  const slug = phase.slug
  const dir = `.sdlc/changes/${slug}`
  return {
    async begin() {
      sb.git('checkout', '-q', '-b', `sdlc/${slug}`)
      must(sb.sdlc(['new', slug, '--type', phase.type, '--tier', phase.tier, '--title', phase.title]), 'new')
      sb.write(`${dir}/intent.md`, intentMd(sb, slug, phase))
      return slug
    },
    async step(node) {
      switch (node) {
        case 'design': sb.write(`${dir}/design.md`, phase.design); break
        case 'build':
          copy(sb, phase.tests)
          must(sb.sdlc(['run', '--slug', slug, '--expect-fail', '--', 'npm test']), 'red run')
          copy(sb, phase.impl)
          must(sb.sdlc(['run', '--slug', slug, '--', 'npm test']), 'green run')
          must(sb.sdlc(['ratchet', 'record', slug, 'build', '--slice', '1', '--checks']), 'record slice 1')
          break
        case 'test': must(sb.sdlc(['verify', slug]), 'verify'); break
        case 'sensors': must(sb.sdlc(['quality', slug]), 'quality'); break
        case 'pr': must(sb.sdlc(['pr', slug, '--message', phase.commit]), 'pr'); break
        case 'pr-review':
          sb.write(`${dir}/review-pr.md`, 'verdict: pass\n')
          sb.write(`${dir}/review.md`, '---\nresult: pass\nrounds: 1\ncaught: 0\n---\n# Review\n\nNo findings.\n')
          must(sb.sdlc(['ratchet', 'record', slug, 'pr-review', '--from', `${dir}/review-pr.md`]), 'record pr-review')
          must(sb.sdlc(['pr-checks', slug]), 'pr-checks')
          break
        default: throw new Error(`scripted driver has no handler for node ${node}`)
      }
    },
  }
}
```

`tests/e2e/lib/report.mjs`:

```js
import fs from 'node:fs'
import path from 'node:path'

export function writeReport(out, list) {
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(list.map(c => c.toJSON()), null, 2))
  const md = list.map(c => `## ${c.title}\n\n${c.results.map(r => `- ${r.status} ${r.name}${r.why ? ` (${r.why})` : ''}`).join('\n')}\n`).join('\n')
  fs.writeFileSync(path.join(out, 'report.md'), `# e2e report\n\n${md}`)
}
```

`tests/e2e/run.mjs` (P0 and P1 now; later tasks add phases):

```js
// node tests/e2e/run.mjs [--driver scripted|live] [--phase P0|P1|P2|P3|P4] [--keep] [--out DIR]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSandbox } from '../integration/lib/sandbox.mjs'
import { writeReport } from './lib/report.mjs'
import { install } from './phases/p0-install.mjs'
import { PHASE as P1, runChange } from './phases/p1-greenfield.mjs'
import { scriptedDriver } from './driver/scripted.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const driverName = arg('driver', 'scripted')
const only = arg('phase')
const out = path.resolve(arg('out', fs.mkdtempSync(path.join(os.tmpdir(), 'rig-e2e-'))))
if (driverName !== 'scripted') throw new Error('live driver arrives in Task 8')

const sb = createSandbox({ name: 'project', out })
const results = []
const want = id => !only || only === id
const finish = () => {
  writeReport(out, results)
  for (const c of results) c.print()
  const failed = results.some(c => c.failed.length)
  console.log(`\nreport and sandbox: ${out}`)
  process.exitCode = failed ? 1 : 0
}

try {
  results.push(await install(sb))
  if (want('P1')) results.push((await runChange(sb, P1, scriptedDriver(sb, P1), { first: true })).checks)
} catch (err) {
  console.error(`e2e aborted: ${err.message}\nsandbox kept at ${out}`)
  process.exitCode = 1
}
finish()
```

- [ ] **Step 5: Run it and fix route mismatches**

Run: `npm run test:e2e`
Expected: P0 all PASS; P1 either all PASS or aborts with a specific message (e.g. `no progress at test`, `blocked: ...`, `scripted driver has no handler for node X`). The operator's guards make a mismatch between the handlers and the real route loud. For each abort: read `sdlc.ts next <slug> --json` in the kept sandbox (`<out>/project/repo`), change the matching `case` in `scripted.mjs` to do what that node's skill does (`skills/<node>/SKILL.md`), rerun. Do not weaken a guard. Expected end state: every check PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e
git commit -m "test(e2e): P0 install and P1 greenfield cart through the real route"
```

---

### Task 3: Seeded-bad twins for P1 (proof the assertions can fail)

**Files:**
- Create: `tests/e2e/negative.mjs`
- Modify: `tests/e2e/run.mjs` (call it), `package.json` (`test:e2e` runs run.mjs then negative.mjs)

**Interfaces:**
- Produces: `runNegatives(sb, slug) -> Checks[]`. Each twin mutates the sandbox, runs the assertion, expects named checks to FAIL, restores.

- [ ] **Step 1: Write the failing test.** `tests/e2e/negative.mjs` first with only the helper and one twin (approval removed), then run it expecting the twin to reveal that `assertChange` flags it.

```js
// Each twin breaks the evidence one way and requires the assertion meant to catch it to fail.
import { Checks } from '../integration/lib/checks.mjs'
import { assertChange } from '../integration/assert/change.mjs'

// Every check matching `failing` must FAIL, every other check must PASS. Returns the surprises.
function surprises(c, failing) {
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
    bad.push(...surprises(c, [/approved exactly the gates/, /tree clean/]))
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
```

In `run.mjs`, after P1: `const { runNegatives } = await import('./negative.mjs')`; `const bad = await runNegatives(sb, P1.slug)`; if `bad.length` print each and set `process.exitCode = 1`. (The sandbox must still be on branch `sdlc/cart`, so run negatives before `mergeToMain`.)

- [ ] **Step 2: Run, adjust regexes to the exact check names**

Run: `npm run test:e2e`
Expected: no surprises. If `no check matched`, print `c.results.map(r => r.name)` once and fix the regex to a real name from `tests/integration/assert/change.mjs` (the selftest uses `/approved exactly the gates/`, `/tree clean/`, `/every approval is the operator's/`, which exist).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e && git commit -m "test(e2e): seeded-bad twins for the change assertions"
```

---

### Task 4: P2 small change on the built cart

**Files:**
- Create: `tests/e2e/phases/p2-change.mjs`, `tests/e2e/fixtures/p2/src/cart.js`, `tests/e2e/fixtures/p2/test/coupon.test.js`
- Modify: `tests/e2e/run.mjs`, `tests/e2e/negative.mjs`

**Interfaces:**
- Consumes: `runChange`, `mergeToMain`, `scriptedDriver`.
- Produces: `PHASE` for P2 (slug `coupon`, type `feature`, tier `M`, acceptance `coupon`).

- [ ] **Step 1: Fixtures.** `fixtures/p2/src/cart.js` is the P1 file plus a coupon:

```js
const COUPONS = { SAVE10: 10 }

export class Cart {
  #lines = new Map()
  #coupon = null

  add(sku, priceCents, qty = 1) {
    if (!Number.isInteger(qty) || qty <= 0) throw new RangeError('qty must be a positive integer')
    if (!Number.isInteger(priceCents) || priceCents < 0) throw new RangeError('priceCents must be a non-negative integer')
    const line = this.#lines.get(sku)
    this.#lines.set(sku, { sku, priceCents, qty: (line?.qty ?? 0) + qty })
  }

  remove(sku) {
    if (!this.#lines.delete(sku)) throw new Error(`not in cart: ${sku}`)
  }

  lines() {
    return [...this.#lines.values()].sort((a, b) => (a.sku < b.sku ? -1 : 1)).map(l => ({ ...l }))
  }

  applyCoupon(code) {
    if (!(code in COUPONS)) throw new Error(`unknown coupon: ${code}`)
    this.#coupon = code
  }

  totalCents() {
    const gross = this.lines().reduce((n, l) => n + l.priceCents * l.qty, 0)
    return this.#coupon ? Math.floor((gross * (100 - COUPONS[this.#coupon])) / 100) : gross
  }
}
```

`fixtures/p2/test/coupon.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { Cart } from '../src/cart.js'

test('SAVE10 takes 10% off, rounded down', () => {
  const c = new Cart()
  c.add('A', 1999)
  c.applyCoupon('SAVE10')
  assert.equal(c.totalCents(), 1799)
})

test('applying a coupon twice does not stack', () => {
  const c = new Cart()
  c.add('A', 1000)
  c.applyCoupon('SAVE10')
  c.applyCoupon('SAVE10')
  assert.equal(c.totalCents(), 900)
})

test('an unknown coupon throws', () => {
  assert.throws(() => new Cart().applyCoupon('NOPE'), /unknown coupon/)
})
```

- [ ] **Step 2: Phase** `tests/e2e/phases/p2-change.mjs`:

```js
import path from 'node:path'

const fx = rel => path.join(import.meta.dirname, '../fixtures/p2', rel)

export const PHASE = {
  id: 'P2', slug: 'coupon', type: 'feature', tier: 'M', title: 'Cart coupon',
  prompt: '/rig-start Add Cart.applyCoupon(code). SAVE10 takes 10% off the cart total; any other code throws an Error whose message contains "unknown coupon". totalCents() then returns the discounted total rounded DOWN to a whole cent; applying a coupon twice keeps a single 10% discount. Everything that worked before must behave the same when no coupon is applied. Include tests.',
  intent: {
    problem: 'Shoppers cannot apply a discount code.',
    outcome: 'applyCoupon(SAVE10) discounts totalCents by 10% rounded down; unknown codes throw; earlier behaviour unchanged.',
    nonGoals: 'More than one coupon code, stacking, expiry.',
    risks: 'Rounding: use integer math, floor to the cent.',
  },
  design: [
    '# Coupon', '', '## Contracts', '- `Cart.applyCoupon(code)`; `totalCents()` reflects the coupon.', '',
    '## Files', '- src/cart.js', '- test/coupon.test.js', '',
    '## Slices', '1. applyCoupon and discounted total (test/coupon.test.js)', '',
    '## Verification', '- npm test', '',
  ].join('\n'),
  tests: [{ src: fx('test/coupon.test.js'), dest: 'test/coupon.test.js' }],
  impl: [{ src: fx('src/cart.js'), dest: 'src/cart.js' }],
  commit: 'feat(cart): apply a SAVE10 coupon',
  acceptance: 'coupon',
}
```

- [ ] **Step 3: Wire into run.mjs.** After P1 and its negatives: `mergeToMain(sb, P1.slug)`, then `results.push((await runChange(sb, P2, scriptedDriver(sb, P2))).checks)`. Add a P2-only check block using `sb`:

```js
// Edited, not rewritten: under 80% of cart.js lines deleted relative to main.
const del = Number(sb.git('diff', '--numstat', 'main...HEAD', '--', 'src/cart.js').split('\t')[1])
const total = sb.git('show', 'main:src/cart.js').split('\n').length
await c2.check('P2: cart.js was edited, not rewritten', () => del / total < 0.8 || `${del} of ${total} lines deleted`)
```

(`c2` is the Checks returned by `runChange`.)

- [ ] **Step 4: Stale-approval twin** in `negative.mjs` (export `runStaleTwin(sb, slug)`): append a line to `design.md`, run `sb.sdlc(['next', slug, '--json'])`, require `verdict === 'human'` (gate reported stale), then `git checkout -- .sdlc/changes/<slug>/design.md`. Run it on P2 before the merge step.

```js
export async function runStaleTwin(sb, slug) {
  const f = `.sdlc/changes/${slug}/design.md`
  const keep = sb.read(f)
  sb.write(f, `${keep}\n- edited after approval\n`)
  const n = JSON.parse(sb.sdlc(['next', slug, '--json']).stdout)
  sb.write(f, keep)
  return n.verdict === 'human' ? [] : [`stale approval: next said ${n.verdict}, expected human`]
}
```

- [ ] **Step 5: Run and fix**

Run: `npm run test:e2e`
Expected: P2 all PASS including `no regression: cart`; no twin surprises.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e && git commit -m "test(e2e): P2 small change on the built cart, stale-approval twin"
```

---

### Task 5: P3 deploy (local only)

**Files:**
- Create: `tests/e2e/assert/deploy.mjs`, `tests/e2e/phases/p3-deploy.mjs`
- Modify: `tests/e2e/run.mjs`, `package.json` (devDependency `yaml`)

**Interfaces:**
- Produces: `assertProductionGate(c, sb)`, `assertRollbackRehearsal(c, sb)`, `assertWorkflows(c)`; `runDeploy(sb) -> Checks`.

- [ ] **Step 1: Install the dependency.** Run: `npm install --save-dev yaml@2` (expected: package.json and package-lock.json change; ask the person first if offline policy applies).

- [ ] **Step 2: Write `tests/e2e/assert/deploy.mjs`**

```js
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { PLUGIN } from '../../integration/lib/sandbox.mjs'

const GATE = path.join(PLUGIN, 'templates/production-gate.sh')
const payload = (command, session = 's1') => JSON.stringify({ session_id: session, tool_input: { command } })

function gate(sb, command, env = {}) {
  return spawnSync('sh', [GATE], { input: payload(command), encoding: 'utf8', env: { ...sb.env, CLAUDE_PROJECT_DIR: sb.dir, ...env } })
}

export async function assertProductionGate(c, sb) {
  // The gate logs only when .sdlc exists; P0 created it, but never rely on it.
  fs.mkdirSync(sb.file('.sdlc'), { recursive: true })
  fs.rmSync(sb.file('.sdlc/gates.jsonl'), { force: true })

  const blocked = gate(sb, 'npm run deploy -- --env production')
  await c.check('deploy gate: production without RELEASE_APPROVAL exits 2 with the route', () =>
    (blocked.status === 2 && /RELEASE_APPROVAL/.test(blocked.stderr)) || `exit ${blocked.status}: ${blocked.stderr.trim()}`)

  const allowed = gate(sb, 'npm run deploy -- --env production', { RELEASE_APPROVAL: 'CHG-1' })
  await c.check('deploy gate: production with RELEASE_APPROVAL exits 0', () => allowed.status === 0 || `exit ${allowed.status}`)

  const other = gate(sb, 'npm run deploy -- --env staging')
  await c.check('deploy gate: a staging deploy is not gated', () => other.status === 0 || `exit ${other.status}`)

  const plain = gate(sb, 'npm test')
  await c.check('deploy gate: an unrelated command is not gated', () => plain.status === 0 || `exit ${plain.status}`)

  await c.check('deploy gate: logs the block and the allow, and nothing else', () => {
    const rows = sb.read('.sdlc/gates.jsonl').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    const got = rows.map(r => r.decision).join(',')
    return got === 'block,allow' || `decisions: ${got}`
  })
  await c.check('deploy gate: never logs the command text', () => !/deploy|npm/.test(sb.read('.sdlc/gates.jsonl')) || 'command text found in gates.jsonl')
}

// RIG_ROLLBACK_COMMAND is a script the project owns; the rehearsal is that command running and succeeding.
export async function assertRollbackRehearsal(c, sb) {
  sb.write('scripts/rollback.sh', '#!/bin/sh\necho rolled-back > .rollback-ran\n')
  const r = sb.run('sh', ['-c', 'RIG_ROLLBACK_COMMAND="sh scripts/rollback.sh"; sh -c "$RIG_ROLLBACK_COMMAND"'])
  await c.check('rollback rehearsal: the rollback command runs and succeeds', () => (r.status === 0 && sb.exists('.rollback-ran')) || `exit ${r.status}`)
  sb.run('rm', ['-f', sb.file('.rollback-ran'), sb.file('scripts/rollback.sh')])
}

// Every workflow template must parse, and every sdlc.ts subcommand it calls must exist in the CLI's command table.
export async function assertWorkflows(c) {
  const cli = fs.readFileSync(path.join(PLUGIN, 'scripts/sdlc.ts'), 'utf8')
  const known = cmd => new RegExp(`^\\s+'?${cmd}'?:`, 'm').test(cli)
  for (const f of fs.readdirSync(path.join(PLUGIN, 'templates')).filter(n => /^rig-.*\.yml$/.test(n))) {
    const text = fs.readFileSync(path.join(PLUGIN, 'templates', f), 'utf8')
    await c.check(`workflow ${f}: parses as YAML with jobs`, () => Object.keys(parse(text).jobs ?? {}).length > 0 || 'no jobs')
    const cmds = [...text.matchAll(/sdlc\.ts\s+([a-z][a-z-]*)/g)].map(m => m[1])
    await c.check(`workflow ${f}: every sdlc.ts command it calls exists`, () => {
      const missing = [...new Set(cmds)].filter(x => !known(x))
      return missing.length === 0 || `unknown: ${missing.join(', ')}`
    })
  }
}
```

- [ ] **Step 3: Phase wrapper** `tests/e2e/phases/p3-deploy.mjs`:

```js
import { Checks } from '../../integration/lib/checks.mjs'
import { assertProductionGate, assertRollbackRehearsal, assertWorkflows } from '../assert/deploy.mjs'

export async function runDeploy(sb) {
  const c = new Checks('P3 deploy (local)')
  await assertProductionGate(c, sb)
  await assertRollbackRehearsal(c, sb)
  await assertWorkflows(c)
  return c
}
```

Wire `if (want('P3')) results.push(await runDeploy(sb))` in `run.mjs` after P2 (it does not need a branch; sandbox is on `main` after the merge).

- [ ] **Step 4: Run and fix**

Run: `npm run test:e2e -- --phase P3` is not valid (P3 needs P0 only; `run.mjs` already installs first), so run: `node tests/e2e/run.mjs --phase P3`
Expected: all PASS. If a workflow check reports `unknown: x`, open the cited template and the command table; if the command is real but spelled differently in the table, adjust `known`'s regex; if it is truly missing, that is a harness bug, report it, do not hide it.

- [ ] **Step 5: Add negative twins** to `negative.mjs` (`runDeployNegatives()`): run `gate` with a payload `deploy production` and `RELEASE_APPROVAL=''`, require exit 2; feed `assertWorkflows` is already covered by the real files, so instead twin it with a temp template containing `sdlc.ts nonsense-cmd` by exporting `assertWorkflowText(c, name, text)` from `deploy.mjs` (refactor the loop body into it) and requiring the `every sdlc.ts command` check to FAIL.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e package.json package-lock.json && git commit -m "test(e2e): P3 deploy gate, rollback rehearsal and workflow lint"
```

---

### Task 6: P4 maintain

**Files:**
- Create: `tests/e2e/assert/maintain.mjs`, `tests/e2e/phases/p4-maintain.mjs`, `tests/e2e/fixtures/p4/src/cart.js`, `tests/e2e/fixtures/p4/test/regression.test.js`
- Modify: `tests/e2e/run.mjs`, `tests/e2e/negative.mjs`, `tests/e2e/driver/scripted.mjs`

**Interfaces:**
- Produces: `assertWatch(c, sb)`, `assertIncident(c, sb, file)`, `runMaintain(sb, driver) -> Checks[]`.

The incident: "removing a SKU that was added twice leaves a ghost line" is not a real bug in the built cart, so seed one: P4's fixture `cart.js` is the P2 file with `totalCents` changed so a coupon is applied to a negative gross floor incorrectly is contrived. Use this simple seeded bug instead: `lines()` returns the *internal* line objects (callers can mutate cart state). The regression test mutates a returned line and requires the cart total unchanged. P2's `cart.js` already copies the lines (`.map(l => ({ ...l }))`), so the **setup** step of P4 reintroduces the bug on `main` (commit `chore: seed bug`) by replacing `.map(l => ({ ...l }))` with nothing, and the fixture fix restores it.

- [ ] **Step 1: Fixtures.** `fixtures/p4/src/cart.js` is byte-identical to `fixtures/p2/src/cart.js`. `fixtures/p4/test/regression.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { Cart } from '../src/cart.js'

test('lines() returns copies: mutating a returned line does not change the cart', () => {
  const c = new Cart()
  c.add('A', 100, 2)
  c.lines()[0].qty = 99
  assert.equal(c.totalCents(), 200)
})
```

- [ ] **Step 2: Assertions** `tests/e2e/assert/maintain.mjs`:

```js
const jsonl = t => t.split('\n').filter(Boolean).map(l => JSON.parse(l))
const fm = text => Object.fromEntries([...(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '').matchAll(/^([\w-]+):\s*(.*)$/gm)].map(m => [m[1], m[2].trim()]))

export const BAND = { id: 'checkout-errors', query: 'cat .band-value', window: 5, step: 0.5, minSd: 1, tools: 'Read', routes: ['pull_request'] }

// Feeds .band-value through `watch`: 5 baseline points plus 8 more in-band (the last 8 are kept out of the baseline),
// then one point far beyond 3 sigma. In-band points must write no breach intent; the breach must write one.
export async function assertWatch(c, sb) {
  const sensors = JSON.parse(sb.read('.sdlc/sensors.json'))
  sb.write('.sdlc/sensors.json', JSON.stringify({ ...sensors, bands: [BAND] }, null, 2) + '\n')
  const point = v => { sb.write('.band-value', `${v}\n`); return JSON.parse(sb.sdlc(['watch', '--json']).stdout)[0] }
  let last
  for (const v of [10, 11, 10, 9, 10, 10, 11, 10, 9, 10, 10, 11, 10]) last = point(v)
  const breachFiles = () => sb.run('sh', ['-c', 'ls .sdlc/intent 2>/dev/null | grep -c breach- || true']).stdout.trim()
  await c.check('watch: in-band points are tier 0 and write no breach intent', () =>
    (last.tier === 0 && breachFiles() === '0') || `tier ${last.tier}, ${breachFiles()} breach file(s)`)
  const breach = point(60)
  await c.check('watch: a point far beyond 3 sigma is tier 3 with a breach name', () =>
    (breach.tier === 3 && /^breach-checkout-errors-\d{8}$/.test(breach.breach)) || JSON.stringify(breach))
  // Intent files are written by the CI job from the breach name (rig-watch.yml); the test plays that job.
  sb.write(`.sdlc/intent/${breach.breach}.md`, `---\nstatus: draft\n---\n# Breach: ${BAND.id}\n\nValue ${breach.value} beyond 3 sigma.\n`)
  await c.check('watch: the breach intent is a draft the person triages', () => fm(sb.read(`.sdlc/intent/${breach.breach}.md`)).status === 'draft')
  await c.check('watch: history file holds every point', () => jsonl(sb.read('.sdlc/watch/checkout-errors.jsonl')).length === 14)
}

export async function assertIncident(c, sb, file) {
  const f = fm(sb.read(file))
  await c.check('incident: has class, severity, escaped, detected', () =>
    ['class', 'severity', 'escaped', 'detected'].every(k => f[k]) || `missing: ${['class', 'severity', 'escaped', 'detected'].filter(k => !f[k])}`)
  await c.check('incident: restored is blank until the fix ships', () => f.restored === '' || f.restored === undefined)
}

export async function assertRestoredMetrics(c, sb, file) {
  const text = sb.read(file)
  sb.write(file, text.replace(/^restored:.*$/m, `restored: ${new Date(Date.now() + 3600e3).toISOString()}`))
  sb.commitAll('chore: incident restored')
  const m = JSON.parse(sb.sdlc(['metrics', '--json']).stdout)
  await c.check('metrics: time_to_restore_hours is reported once restored is set', () => m.time_to_restore_hours?.value !== undefined && m.time_to_restore_hours.value !== null || JSON.stringify(m.time_to_restore_hours))
  await c.check('metrics: repeat_incident_share is present', () => 'repeat_incident_share' in m || 'missing key')
}
```

- [ ] **Step 3: Phase** `tests/e2e/phases/p4-maintain.mjs`:

```js
import path from 'node:path'
import { Checks } from '../../integration/lib/checks.mjs'
import { assertChange } from '../../integration/assert/change.mjs'
import { assertCart } from '../../integration/acceptance/cart.mjs'
import { runRoute } from '../lib/operator.mjs'
import { assertWatch, assertIncident, assertRestoredMetrics } from '../assert/maintain.mjs'

const fx = rel => path.join(import.meta.dirname, '../fixtures/p4', rel)
const INCIDENT = '.sdlc/incidents/20261009-lines-leak-internal-state.md'

export const PHASE = {
  id: 'P4', slug: 'lines-copy', type: 'incident', tier: 'M', title: 'lines() leaks internal state',
  prompt: '/rig-incident "Cart.lines() returns live internal objects; a caller mutating a line changes the cart total" --escaped',
  intent: {
    problem: 'Callers that mutate a line returned by lines() silently change the cart.',
    outcome: 'lines() returns copies; a regression test pins it.',
    nonGoals: 'Freezing the objects.',
    risks: 'none',
  },
  design: '',
  tests: [{ src: fx('test/regression.test.js'), dest: 'test/regression.test.js' }],
  impl: [{ src: fx('src/cart.js'), dest: 'src/cart.js' }],
  commit: 'fix(cart): lines() returns copies',
  acceptance: 'coupon',
}

export async function runMaintain(sb, driver) {
  const out = []
  const w = new Checks('P4 maintain: watch')
  await assertWatch(w, sb)
  out.push(w)

  // Seed the escaped bug on main, as if it had shipped, then open the incident.
  sb.write('src/cart.js', sb.read('src/cart.js').replace('.map(l => ({ ...l }))', ''))
  sb.commitAll('chore: seed the lines() leak (simulates the escaped bug)')
  sb.write(INCIDENT, [
    '---', 'class: shared-state', 'severity: sev3', 'escaped: true', `detected: ${new Date().toISOString()}`,
    'restored:', `intent_at: ${new Date().toISOString()}`, '---', '', 'Symptoms: totals drift after callers edit lines().', 'Impact: wrong totals.', 'Evidence: see test/regression.test.js.', '',
  ].join('\n'))
  sb.commitAll('docs: incident record')
  const i = new Checks('P4 maintain: incident')
  await assertIncident(i, sb, INCIDENT)
  out.push(i)

  const slug = await driver.begin()
  const route = await runRoute({ sb, slug, driver, expectGates: () => ['plan'] })
  const c = new Checks('P4 maintain: incident fix')
  await assertChange(c, sb, slug, { label: slug })
  await c.check('P4: the regression test failed on base (red-proof ran)', () => /expectFail|"expectFail":true/.test(sb.read(`.sdlc/changes/${slug}/runs.jsonl`)) || 'no red run recorded')
  await assertCart(c, sb.dir, 'coupon')
  out.push(c)

  const m = new Checks('P4 maintain: metrics')
  await assertRestoredMetrics(m, sb, INCIDENT)
  out.push(m)
  return { checks: out, route }
}
```

- [ ] **Step 4: Scripted driver gets a `diagnose` node.** Add to the `switch` in `scripted.mjs`:

```js
        case 'diagnose':
          copy(sb, phase.tests)
          must(sb.sdlc(['run', '--slug', slug, '--expect-fail', '--', 'npm test']), 'red run')
          copy(sb, phase.impl)
          must(sb.sdlc(['run', '--slug', slug, '--', 'npm test']), 'green run')
          break
        case 'plan': sb.write(`${dir}/plan.md`, phase.design); break
```

For the incident change, `begin()` must be given the incident file: `new` is called with `--type incident` as already coded; also write `phase.intent` plus a link line `Incident: ${INCIDENT}` — put that in `phase.intent.problem`.

- [ ] **Step 5: Run and fix**

Run: `node tests/e2e/run.mjs --phase P4`
Expected: all PASS. P4 alone needs P2's `cart.js` on `main`, so make `run.mjs` run P1 and P2 first whenever the requested phase is P4 (`want` helper: a phase runs if it is the requested one or a prerequisite: P4 requires P1, P2). Fix the route as in Task 2 Step 5 (the likely mismatch is the node that records the build slice; read `skills/diagnose/SKILL.md`).

- [ ] **Step 6: Twins.** In `negative.mjs` add `runMaintainNegatives(sb)`: (a) feed `assertWatch` an all-in-band series with no breach point (export a `feed(sb, values)` helper from `maintain.mjs`) and require no intent file; (b) call `assertIncident` on a file with `class:` removed and require the first check to FAIL.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e && git commit -m "test(e2e): P4 maintain loop: watch breach, incident, fix, eval and metrics"
```

---

### Task 7: Wire into `npm test` and CI; full run

**Files:**
- Modify: `package.json`, `.github/workflows/ci.yml`

- [ ] **Step 1: Time the full scripted run.**

Run: `time npm run test:e2e:fast`
Expected: exit 0, all phases PASS, wall time printed. If over 60 s, find the slow phase from the report before wiring (spec target: under 60 s).

- [ ] **Step 2: Wire.** In `package.json`, change `test` to: `node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts && npm run typecheck:mod && npm run test:e2e:unit && npm run test:e2e:fast && claude plugin test .`. In `.github/workflows/ci.yml`, ensure the job that runs `npm test` has Node 22.18+ (it already runs the suite); no new job is needed. Add `rig-e2e-*` to nothing else.

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: spec files, typecheck, e2e unit, e2e scripted and `claude plugin test` all pass. Quote the final lines in the PR description.

- [ ] **Step 4: Run twice for repeatability**

Run: `npm run test:e2e:fast && npm run test:e2e:fast`
Expected: both exit 0 with identical check lists (diff the two `report.json` files by check name and status).

- [ ] **Step 5: Commit**

```bash
git add package.json .github && git commit -m "test(e2e): run the scripted acceptance test in npm test and CI"
```

---

### Task 8: Live driver

**Files:**
- Create: `tests/e2e/driver/live.mjs`
- Modify: `tests/e2e/run.mjs`, `tests/integration/assert/process.mjs` only if its field names do not match a captured stream (Step 1 decides)

**Interfaces:**
- Consumes: `readSession(file)`, `assertProcess(c, sessions, {label})`, `totals(sessions)` from `tests/integration/assert/process.mjs`.
- Produces: `liveDriver(sb, phase, { out, capUsd = 6, plugin = false }) -> { begin(), step(node, ctx), sessions }`.

- [ ] **Step 1: Capture one real stream first** (this validates the unverified field names and plugin isolation, per the spec's risk list). In a throwaway directory run:

```bash
claude -p "/help" --output-format stream-json --verbose --max-budget-usd 0.5 --setting-sources project,local > /tmp/probe-stream.jsonl
```

Open the file and confirm: a final `{"type":"result"}` line carries `total_cost_usd`, `is_error`, `permission_denials`, `num_turns`; `assistant` lines carry `message.content[].type == "tool_use"` with `name` and `input`. If a name differs, edit `readSession` in `tests/integration/assert/process.mjs` and its synthetic transcripts in `selftest.mjs`, then run `npm run test:integration:self`.

- [ ] **Step 2: Implement**

```js
// The live driver: real `claude -p` sessions running the vendored skills. Costs money; capped.
import fs from 'node:fs'
import path from 'node:path'
import { readSession, totals } from '../../integration/assert/process.mjs'
import { PLUGIN } from '../../integration/lib/sandbox.mjs'

export function liveDriver(sb, phase, { out, capUsd = 6, plugin = false }) {
  const sessions = []
  const session = (label, prompt, { withPlugin = false } = {}) => {
    const spent = totals(sessions).cost ?? 0
    if (spent >= capUsd) throw new Error(`spend cap $${capUsd} reached ($${spent.toFixed(2)})`)
    const file = path.join(out, 'sessions', `${String(sessions.length).padStart(2, '0')}-${label}.jsonl`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      '--max-budget-usd', String(Math.min(6, capUsd - spent)), '--setting-sources', 'project,local',
      ...(withPlugin ? ['--plugin-dir', PLUGIN] : [])]
    const r = sb.run('claude', args, { timeout: 18 * 60_000 })
    fs.writeFileSync(file, r.stdout ?? '')
    if (r.status !== 0 && !r.stdout) throw new Error(`claude exited ${r.status}: ${(r.stderr ?? '').split('\n')[0]}`)
    sessions.push(readSession(file))
  }
  return {
    sessions,
    async begin() {
      session(`${phase.id}-start`, phase.prompt)
      const active = JSON.parse(sb.sdlc(['status', '--json']).stdout).active
      if (!active) throw new Error(`${phase.id}: /rig-start created no change`)
      return active
    },
    async step(node) {
      session(`${phase.id}-${node}`, '/rig-next — continue through the next node; commit on the branch')
    },
  }
}
```

If `totals()` has no `cost` field, use the field it does return (read `assert/process.mjs:31`).

- [ ] **Step 3: Wire `run.mjs`.** Replace the `throw` for non-scripted drivers with a `makeDriver(sb, phase)` that returns `liveDriver(sb, phase, { out, capUsd: Number(arg('cap', 6)) })` for `--driver live`; for live P0, run `sb.run('claude', ['-p', '/rig:init --defaults greenfield "<SCAFFOLD>"', '--plugin-dir', PLUGIN, ...])` instead of `install(sb)`, then run `assertOnboarding`. After all phases, call `assertProcess(c, driver.sessions, { label })` per phase and include the per-session cost in the report. P3 runs unchanged (no model).

- [ ] **Step 4: Run P0 + P1 live once**

Run: `npm run test:e2e -- --phase P1 --cap 6` (real Claude Code)
Expected: either PASS, or specific findings (permission denials, unexpected gates, tier drift). Record findings in the PR description; they are the point of this driver. Do not loosen an assertion to make it pass; file the finding.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e && git commit -m "test(e2e): live driver with spend cap, stream capture and process assertions"
```

---

## Final verification and review (per CLAUDE.md)

- [ ] `npm test` (quote the tail), `npm run typecheck`.
- [ ] One review: `git diff main...HEAD` via `/code-review` (single Sonnet reviewer; Opus only if a tier L change). Fix findings in one wave.
- [ ] README: add a short "End-to-end acceptance test" section under the test docs pointing at `npm run test:e2e` (real Claude Code), `npm run test:e2e:fast` (fake model), and the spec.

## Self-review against the spec

- §1 goal / scaffold / greenfield / change / deploy / maintain: Tasks 2, 4, 5, 6.
- §2 two drivers, one library: Tasks 2 (scripted) and 8 (live); both go through `runChange` and the M1 assertions.
- §3 layout: matches File Structure; `report.mjs` is Task 2.
- §4 operator table: Task 1 tests cover continue, human (expected and unexpected, budget/tier), blocked, no-progress, step cap, ready/done. The merger step is `mergeToMain` (Task 1), used in Tasks 4 and 6.
- §5 sandbox: reuses `createSandbox`; live driver uses `acceptEdits`, no `--allowedTools`, `--setting-sources project,local`, plugin only at live P0.
- §6 P0 to P4 assertions: P3 rollback metric is intentionally the command-runs check (stub `gh`), a documented correction to the spec; `repeat_incident_class` in the spec is the metric `repeat_incident_share`.
- §7 determinism / twins: Tasks 3, 4, 5, 6 add twins; Task 7 Step 4 checks repeatability.
- §9 milestones: E1 = Tasks 1-3, E2 = Task 4, E3 = Tasks 5-7, E4 = Task 8.
- Known fragile points, named so the executor expects them: the scripted node handlers (Task 2 Step 5, Task 6 Step 5) are reconciled against the real route by running it.
