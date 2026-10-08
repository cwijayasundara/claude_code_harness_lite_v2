# M2 Intent Inbox, Policy Concerns and Spec Job Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A product owner can drop an idea into `.sdlc/intent/` and get a reviewed intent.md and design.md back as a pull request, with every policy conflict flagged as a `## Concerns` line that blocks approval until its owner resolves it.

**Architecture:** A leaf script, `scripts/inbox.ts`, reads `.sdlc/intent/*.md` and derives each entry's state (people write `draft | accepted | closed`; `shipped` is derived from the change whose intent.md names the file as `source:`). Four consumers use it: `sdlc.ts inbox` (CLI and CI), `status` (a "waiting" warning), `metrics` (inbox survival) and the spec workflow (which intents to draft, and with which model). `/rig:start` reads an inbox file directly; a new `/rig:intent` skill writes one. A `## Concerns` gate sits next to the existing open-questions gate in `approve`. `templates/rig-spec.yml` drafts in a read-only model job and publishes from a model-free job.

**Tech Stack:** Node 22.18+ running TypeScript directly (no build step, no dependencies), `node:test`, POSIX `sh`/bash, GitHub Actions YAML, Claude Code CLI and `anthropics/claude-code-action`.

**Spec:** `docs/ai-sdlc-harness-design.html` (§5.1 Stage 1 intent inbox, §5.2 Stage 2 policy skills, concerns, spec job; §10 M2; §11 decisions). Revised 2026-10-08 during planning: the inbox gets a small script (`inbox.ts`) instead of prompt text only, because four consumers need the same derived state; the harness line cap rises to 7,900.

## Global Constraints

- The harness line cap in `scripts/size.spec.ts` is **7,900** (raised from 7,600 in Task 1). Every script ≤ 500 lines, mod file ≤ 300, skill and guide ≤ 60.
- The inbox is `.sdlc/intent/`. An inbox file name is `<kebab>.md` matching `^[a-z0-9][a-z0-9-]{0,60}\.md$`; other names are listed but never drafted by CI.
- Inbox `status:` written by people: `draft`, `accepted`, `closed`. `shipped` is never written; it is derived (a change with `source: .sdlc/intent/<file>` in its intent.md frontmatter has shipped).
- A change records its inbox file as `source: .sdlc/intent/<file>` in intent.md frontmatter, written by `sdlc.ts new --source`.
- Model for an inbox entry follows M0's rule: tier S `haiku`, M `sonnet`, L or `type: greenfield` `opus`; **no valid tier → `opus`** (fail closed).
- Concerns: a bullet under `## Concerns` other than `none` blocks approval of spec, plan or design until it contains `resolved:`. A document with no `## Concerns` section is not blocked (changes in flight keep working).
- Policy skills: `.claude/skills/policy-<area>/SKILL.md` with frontmatter `name`, `description`, `owner`, `source`.
- The spec workflow never builds: it passes `--plan-only` to `/rig-start`, and the model job has a read-only token; only the model-free publish job can push.
- Per-turn cost stays flat: nothing in `status --json --band` or any settings hook reads the inbox.
- Scripts: zero dependencies, plain Node, sibling `./*.ts` imports only.
- **No dogfooding:** never run `sdlc.ts new`, `init`, `inbox`, `evals` or any rig check against this repository itself. Tests create their own temp repos. Verify with `npm run typecheck`, `node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`, `claude plugin validate .claude-plugin/plugin.json`.
- Commit messages: one line, `type: summary`, a blank line, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Line budget (cap 7,900; harness at 7,160)

| Item | Lines | Task |
|---|---|---|
| `scripts/inbox.ts` | ≈ 45 | 2 |
| `sdlc.ts` (`inbox` command, `new --source`, status warning, concerns gate, init scaffold) | ≈ 20 | 1, 3, 4, 6 |
| `core.ts` intent template `source:` line | +1 | 1 |
| `model.ts` `unresolvedConcerns` + `stale.ts` | ≈ 10 | 4 |
| `metrics.ts` two metrics | ≈ 8 | 3 |
| `templates/design-format.md` | +2 | 4 |
| skills: `start`, `design`, `plan`, `spec` edits; new `intent` skill | ≈ 40 | 5 |
| `templates/policy-security.md` | ≈ 20 | 6 |
| `templates/rig-spec.yml` | ≈ 100 | 7 |
| **M2 total** | **≈ 250** → harness ≈ 7,410 | |
| Reserved for M3–M6 (spec §9: `watch.ts` 150, preflight 25, gate 15, managed settings 45, three workflows ≈ 135, metrics ≈ 20) | ≈ 390 | |
| Slack | ≈ 100 | |

If a task runs over, cut in this order: the `policy-security` scaffold (Task 6), then the `inbox` text output (keep `--json`).

## Review Focus

- **Duplicate pull requests.** An accepted intent whose draft PR is still open has no change on the trunk yet, so the next push to the inbox would draft it again. `inbox --pending` must skip an intent whose `origin/sdlc/intent-<name>` branch exists. Pinned in Task 2.
- **A tier S intent in CI.** `/rig-start`'s tier S fast path builds in the same turn. The spec job must never build: `--plan-only` stops `start` after intent.md (and design.md for a feature). Pinned in Task 5 (skill text) and Task 7 (the workflow passes it).
- **The publish job accepts something other than rig's own change files.** A model-written symlink, script, nested folder or second change folder must be refused before anything is pushed. Pinned in Task 7.
- **The concerns gate stalls changes already in flight.** A design or plan written before M2 has no `## Concerns` section and must approve exactly as before. Pinned in Task 4.
- **`new --source` with a path outside the inbox** (`../`, a missing file, a non-`.md` file) must fail before any change folder is created. Pinned in Task 1.

---

### Task 1: Raise the cap to 7,900; `new --source` records the inbox file

**Files:**
- Modify: `scripts/size.spec.ts:40-42`
- Modify: `scripts/core.ts` (`intentTemplate` near line 392, `createChange` near line 420)
- Modify: `scripts/sdlc.ts` (`cmdNew` near line 83)
- Test: `scripts/inbox.spec.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `intentTemplate(slug, type, tier, title, points?, source?)` and `createChange(slug, type, tier, title, points?, source?)`; intent.md frontmatter line `source: .sdlc/intent/<file>`; `sdlc.ts new <slug> ... --source .sdlc/intent/<file>.md`.

- [ ] **Step 1: Create the branch**

```bash
git checkout main
git checkout -b feat/m2-intent-inbox-and-spec-job
```

- [ ] **Step 2: Raise the cap**

In `scripts/size.spec.ts`, replace `test('the harness is at most 7600 lines (tests and docs excluded)', () => {` with `test('the harness is at most 7900 lines (tests and docs excluded)', () => {`, and `assert.ok(total <= 7600, \`harness is ${total} lines\`)` with `assert.ok(total <= 7900, \`harness is ${total} lines\`)`.

- [ ] **Step 3: Write the failing test**

Create `scripts/inbox.spec.ts`:

```ts
// The intent inbox (.sdlc/intent/): files people write before a change exists, and the changes that come from them.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn } from './testkit.ts'

let repo: string
beforeEach(() => { repo = makeRepo() })
const intent = (file: string, fm: string, body = '## Problem\nCustomers phone to ask where their claim is.\n') =>
  write(repo, `.sdlc/intent/${file}`, `---\n${fm}\n---\n# Intent\n\n${body}`)

test('new --source records the inbox file in intent.md and refuses paths outside the inbox', () => {
  intent('claims-status.md', 'status: accepted')
  const ok = sdlc(repo, ['new', 'claims-status', '--type', 'feature', '--tier', 'M', '--source', '.sdlc/intent/claims-status.md'])
  assert.equal(ok.code, 0, ok.stderr)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/changes/claims-status/intent.md'), 'utf8'), /^source: \.sdlc\/intent\/claims-status\.md$/m)
  const bad = ['../x.md', '.sdlc/intent/../../etc.md', '.sdlc/intent/missing.md', '.sdlc/intent/claims-status.txt', 'README.md']
  bad.forEach((source, i) => {
    const r = sdlc(repo, ['new', `other-${i}`, '--source', source])
    assert.notEqual(r.code, 0, source)
    assert.match(r.stderr, /--source/, source)
    assert.equal(fs.existsSync(path.join(repo, `.sdlc/changes/other-${i}`)), false, `${source}: no change folder is created`)
  })
})

test('new without --source writes no source line', () => {
  sdlc(repo, ['new', 'plain', '--type', 'chore', '--tier', 'S'])
  assert.doesNotMatch(fs.readFileSync(path.join(repo, '.sdlc/changes/plain/intent.md'), 'utf8'), /^source:/m)
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test scripts/inbox.spec.ts`
Expected: FAIL (no `source:` line).

- [ ] **Step 5: Implement**

In `scripts/core.ts`, change `intentTemplate` to take `source?: string` as a sixth parameter and add the line after `tier:`:

```ts
export const intentTemplate = (slug: string, type: ChangeType, tier: Tier, title: string, points?: number, source?: string): string => `---
slug: ${slug}
type: ${type}
tier: ${tier}
${source ? `source: ${source}\n` : ''}${points ? `points: ${points}\n` : ''}created: ${now()}
---
```

(keep the rest of the template unchanged). Change `createChange` to take `source?: string` as a sixth parameter and pass it: `intentTemplate(slug, type, tier, title, points?.value, source)`.

In `scripts/sdlc.ts` `cmdNew`, update the usage string to include `[--source .sdlc/intent/<file>.md]`, and directly after the `if (!isTier(tier)) fail(...)` line add:

```ts
  // An inbox file only: a plain kebab .md name under .sdlc/intent/ that exists (no `..`, no other directory).
  const source = optString(args, 'source')
  if (source !== undefined && (!/^\.sdlc\/intent\/[a-z0-9][a-z0-9-]{0,60}\.md$/.test(source) || !exists(path.join(ROOT, source)))) fail(`--source must name an existing .sdlc/intent/<kebab-name>.md file, not "${source}"`)
```

and pass `source` as the last argument of the `createChange(...)` call. (`ROOT` and `exists` are already imported in `sdlc.ts`; if not, add them to the `./core.ts` import.)

- [ ] **Step 6: Run the tests and the typecheck**

Run: `node --disable-warning=ExperimentalWarning --test scripts/inbox.spec.ts scripts/size.spec.ts scripts/graph.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/size.spec.ts scripts/core.ts scripts/sdlc.ts scripts/inbox.spec.ts
git commit -m "feat: new --source records the inbox file a change comes from; cap 7900" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `sdlc.ts inbox` lists the inbox with derived state, pending entries and the model per entry

**Files:**
- Create: `scripts/inbox.ts`
- Modify: `scripts/sdlc.ts` (import and `COMMANDS` entry `inbox`)
- Modify: `scripts/vendor.ts:8` (`VENDORED`: add `'inbox'` after `'evals'`)
- Test: `scripts/inbox.spec.ts` (append)

**Interfaces:**
- Consumes: `source:` frontmatter (Task 1); `modelFor(type, tier)`, `isChangeType`, `isTier`, `type ModelAlias` from `graph.ts`; `SDLC`, `CHANGES`, `exists`, `read`, `out`, `frontmatter`, `listChanges`, `isShipped`, `git`, `type Args`, `type ChangeType`, `type Tier` from `core.ts`.
- Produces (Tasks 3 and 7 rely on these):
  - `export const INBOX: string` (`.sdlc/intent`)
  - `export type InboxEntry = { file: string; status: 'draft' | 'accepted' | 'closed' | 'shipped' | 'unknown'; change: string | null; type: ChangeType | null; tier: Tier | null; model: ModelAlias }`
  - `export function inboxEntries(): InboxEntry[]` (sorted by file)
  - `export const specBranch: (file: string) => string` → `sdlc/intent-<name without .md>`
  - `export function pendingIntents(): InboxEntry[]`
  - `export function cmdInbox(args: Args): void` — `inbox [--pending] [--json]`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/inbox.spec.ts`:

```ts
type Entry = { file: string; status: string; change: string | null; type: string | null; tier: string | null; model: string }
const inbox = (...args: string[]): Entry[] => JSON.parse(sdlc(repo, ['inbox', '--json', ...args]).stdout) as Entry[]

test('inbox lists every intent with its status; shipped comes from the change that names it', () => {
  intent('a-draft.md', 'status: draft')
  intent('b-closed.md', 'status: closed')
  intent('c-shipped.md', 'status: accepted')
  intent('d-odd.md', 'status: maybe')
  sdlc(repo, ['new', 'c-change', '--type', 'chore', '--tier', 'S', '--source', '.sdlc/intent/c-shipped.md'])
  write(repo, '.sdlc/changes/c-change/ship.json', '{}')
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'ship c')
  assert.deepEqual(inbox().map(e => [e.file, e.status, e.change]), [
    ['a-draft.md', 'draft', null], ['b-closed.md', 'closed', null], ['c-shipped.md', 'shipped', 'c-change'], ['d-odd.md', 'unknown', null],
  ])
})

test('--pending: accepted, no change, a kebab name, and no rig-spec branch on the remote yet', () => {
  intent('one.md', 'status: accepted\ntier: M\ntype: feature')
  intent('two.md', 'status: accepted')
  intent('three.md', 'status: draft')
  intent('Has Space.md', 'status: accepted')
  intent('four.md', 'status: accepted')
  sdlc(repo, ['new', 'four-change', '--type', 'chore', '--tier', 'S', '--source', '.sdlc/intent/four.md'])
  gitIn(repo, 'add', '-A')
  gitIn(repo, 'commit', '-qm', 'inbox')
  gitIn(repo, 'update-ref', 'refs/remotes/origin/sdlc/intent-two', 'HEAD')
  assert.deepEqual(inbox('--pending').map(e => e.file), ['one.md'])
})

test('the model follows the intent tier: Opus for greenfield, a missing tier or an invalid one', () => {
  intent('s.md', 'status: accepted\ntier: S')
  intent('m.md', 'status: accepted\ntier: M')
  intent('g.md', 'status: accepted\ntier: S\ntype: greenfield')
  intent('x.md', 'status: accepted')
  intent('bad.md', 'status: accepted\ntier: XL')
  assert.deepEqual(Object.fromEntries(inbox().map(e => [e.file, e.model])), { 'bad.md': 'opus', 'g.md': 'opus', 'm.md': 'sonnet', 's.md': 'haiku', 'x.md': 'opus' })
})

test('an empty or missing inbox lists nothing', () => {
  assert.deepEqual(inbox(), [])
  assert.match(sdlc(repo, ['inbox']).stdout, /intent inbox is empty/)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/inbox.spec.ts`
Expected: FAIL (`usage: sdlc.ts <...>` — no `inbox` command).

- [ ] **Step 3: Implement `scripts/inbox.ts`**

```ts
// The intent inbox (.sdlc/intent/*.md): ideas a product owner commits before any change exists. People write `status:`
// (draft | accepted | closed); `shipped` is derived from the change whose intent.md names the file as its `source:`.
import fs from 'node:fs'
import path from 'node:path'
import { SDLC, CHANGES, exists, read, out, frontmatter, listChanges, isShipped, git, type Args, type ChangeType, type Tier } from './core.ts'
import { modelFor, isChangeType, isTier, type ModelAlias } from './graph.ts'

export const INBOX = path.join(SDLC, 'intent')
export type InboxEntry = { file: string; status: 'draft' | 'accepted' | 'closed' | 'shipped' | 'unknown'; change: string | null; type: ChangeType | null; tier: Tier | null; model: ModelAlias }
const DECLARED = ['draft', 'accepted', 'closed'] as const
const KEBAB_MD = /^[a-z0-9][a-z0-9-]{0,60}\.md$/

export function inboxEntries(): InboxEntry[] {
  if (!exists(INBOX)) return []
  const bySource = new Map<string, string>()
  for (const slug of listChanges()) {
    const source = frontmatter(read(path.join(CHANGES, slug, 'intent.md'))).data.source
    if (source) bySource.set(path.basename(source), slug)
  }
  return fs.readdirSync(INBOX).filter(f => f.endsWith('.md')).sort().map(file => {
    const d = frontmatter(read(path.join(INBOX, file))).data
    const change = bySource.get(file) ?? null
    const declared = (DECLARED as readonly string[]).includes(d.status ?? '') ? (d.status as InboxEntry['status']) : 'unknown'
    const type = isChangeType(d.type) ? d.type : null
    const tier = isTier(d.tier) ? d.tier : null
    // No valid tier is a doubt, and a doubt is Opus (M0's rule).
    return { file, status: change && isShipped(change) ? 'shipped' : declared, change, type, tier, model: tier ? modelFor(type ?? 'feature', tier) : 'opus' }
  })
}

export const specBranch = (file: string): string => `sdlc/intent-${file.replace(/\.md$/, '')}`

// What the rig-spec workflow drafts: accepted, a plain name, no change yet, and no draft branch already on the remote.
export const pendingIntents = (): InboxEntry[] => inboxEntries().filter(e =>
  e.status === 'accepted' && !e.change && KEBAB_MD.test(e.file) && git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${specBranch(e.file)}`]) === null)

export function cmdInbox(args: Args): void {
  const rows = args.opt.pending ? pendingIntents() : inboxEntries()
  if (args.opt.json) return out(JSON.stringify(rows))
  out(rows.length ? rows.map(e => `${e.status.padEnd(9)}${e.file}${e.change ? ` → ${e.change}` : ''}`).join('\n') : 'intent inbox is empty (.sdlc/intent/)')
}
```

If `frontmatter(...).data` is typed so that `d.status`/`d.type`/`d.tier` are `string` (not `string | undefined`), drop the `?? ''`; keep the behaviour.

- [ ] **Step 4: Wire the command and vendoring**

In `scripts/sdlc.ts`, add `import { cmdInbox } from './inbox.ts'` and the `COMMANDS` entry `inbox: cmdInbox,` (after `evals: cmdEvals,`). In `scripts/vendor.ts`, add `'inbox'` to `VENDORED` after `'evals'`.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `node --disable-warning=ExperimentalWarning --test scripts/inbox.spec.ts scripts/vendor.spec.ts scripts/size.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/inbox.ts scripts/inbox.spec.ts scripts/sdlc.ts scripts/vendor.ts
git commit -m "feat: sdlc.ts inbox lists intents with derived state, pending drafts and the model per tier" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `status` names waiting intents; `metrics` reports inbox survival and intent churn

**Files:**
- Modify: `scripts/sdlc.ts` (`cmdStatus`, the full path after the per-change warnings loop, not the `--band` path)
- Modify: `scripts/metrics.ts` (the Plan and Design blocks near lines 80-90)
- Test: `scripts/inbox.spec.ts` (append)

**Interfaces:**
- Consumes: `pendingIntents()`, `inboxEntries()` from `inbox.ts`; `skillRef` (core); `share`, `median`, `firstCommitTime`, `commitTimes`, `rel` already in `metrics.ts`.
- Produces: status line `warn: intent <file> is accepted and has no change: /rig:start .sdlc/intent/<file>`; metrics keys `inbox_survival` and `intent_churn_after_design`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/inbox.spec.ts`:

```ts
test('status names accepted intents that have no change yet; the per-turn band does not read the inbox', () => {
  intent('one.md', 'status: accepted')
  sdlc(repo, ['new', 'other', '--type', 'chore', '--tier', 'S'])
  assert.match(sdlc(repo, ['status']).stdout, /^warn: intent one\.md is accepted and has no change: \/rig:start \.sdlc\/intent\/one\.md$/m)
  assert.doesNotMatch(sdlc(repo, ['status', '--json', '--band']).stdout, /one\.md/)
})

test('metrics: inbox survival over decided intents; intent churn after design is reported', () => {
  for (const [f, s] of [['a.md', 'accepted'], ['b.md', 'accepted'], ['c.md', 'accepted'], ['d.md', 'accepted'], ['e.md', 'closed'], ['f.md', 'draft']]) intent(f, `status: ${s}`)
  const m = JSON.parse(sdlc(repo, ['metrics', '--json']).stdout).metrics
  assert.deepEqual({ value: m.inbox_survival.value, n: m.inbox_survival.n }, { value: 0.8, n: 5 })
  assert.ok('intent_churn_after_design' in m)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="status names|metrics: inbox" scripts/inbox.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the status warning**

In `scripts/sdlc.ts`, import `pendingIntents` from `./inbox.ts` (extend the Task 2 import). In `cmdStatus`, on the full path (after the `for (const c of changes) { ... }` warnings loop, before the `--json` return), add:

```ts
  for (const e of pendingIntents()) warnings.push(`intent ${e.file} is accepted and has no change: ${skillRef('start')} .sdlc/intent/${e.file}`)
```

Do not touch the `--band` early return.

- [ ] **Step 4: Implement the metrics**

In `scripts/metrics.ts`, add `import { inboxEntries } from './inbox.ts'`. After `m.intent_survival = ...` add:

```ts
  // intent_survival counts changes that got past intent; inbox_survival counts inbox ideas the product owner accepted
  // (accepted or shipped) out of every decided one (closed included); drafts and unknown statuses are undecided.
  const decidedInbox = inboxEntries().filter(e => e.status !== 'draft' && e.status !== 'unknown')
  m.inbox_survival = share(decidedInbox.filter(e => e.status !== 'closed').length, decidedInbox.length)
```

After `m.spec_churn_after_plan = ...` add:

```ts
  // Commits to intent.md after the first design or spec commit: the "what" moving after the "how" began.
  m.intent_churn_after_design = median(changes.map(c => {
    const first = firstCommitTime(rel(c, 'design.md')) ?? firstCommitTime(rel(c, 'spec.md'))
    return first ? commitTimes(rel(c, 'intent.md')).filter(t => t > first).length : null
  }))
```

- [ ] **Step 5: Run the tests and the existing status and metrics suites**

Run: `node --disable-warning=ExperimentalWarning --test scripts/inbox.spec.ts scripts/sdlc.spec.ts scripts/stale.spec.ts && npm run typecheck`
Expected: PASS. If an existing test asserts the exact set of metric keys, add the two new keys to it.

- [ ] **Step 6: Commit**

```bash
git add scripts/sdlc.ts scripts/metrics.ts scripts/inbox.spec.ts
git commit -m "feat: status names waiting intents; metrics report inbox survival and intent churn after design" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `## Concerns` blocks approval until each is resolved

**Files:**
- Modify: `scripts/model.ts` (add `unresolvedConcerns` after `openQuestions`, near line 120)
- Modify: `scripts/sdlc.ts` (`cmdApprove`, after the open-questions refusal near line 207)
- Modify: `scripts/stale.ts:41-43` (`openItems`)
- Modify: `templates/design-format.md`
- Test: `scripts/concerns.spec.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function unresolvedConcerns(text: string): string[]` in `model.ts`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/concerns.spec.ts`:

```ts
// A spec, plan or design flags each conflict with a policy skill under ## Concerns; approval waits until each is resolved.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeRepo, sdlc, write } from './testkit.ts'
import { unresolvedConcerns } from './model.ts'

test('unresolvedConcerns: bullets without resolved:, ignoring none and documents without the section', () => {
  assert.deepEqual(unresolvedConcerns('# x\n## Files\n- a\n'), [])
  assert.deepEqual(unresolvedConcerns('## Concerns\nnone\n'), [])
  assert.deepEqual(unresolvedConcerns('## Concerns\n- none\n'), [])
  assert.deepEqual(unresolvedConcerns('## Concerns\n- [policy-security] PII in logs → owner: @sec\n- [policy-brand] colour → owner: @design → resolved: use the token (@design)\n## Risks\n- [x] not a concern\n'),
    ['[policy-security] PII in logs → owner: @sec'])
})

let repo: string
beforeEach(() => {
  repo = makeRepo()
  sdlc(repo, ['new', 'feat', '--type', 'feature', '--tier', 'M'])
})
const design = (concerns: string) => write(repo, '.sdlc/changes/feat/design.md', `## Files\n- src/a.js\n## Verification\n- \`npm test\`\n${concerns}`)
const approve = () => sdlc(repo, ['approve', 'feat', 'design'], { env: { SDLC_HUMAN: '1' } })

test('approve refuses a design with an unresolved concern and names it; status lists it as open', () => {
  design('## Concerns\n- [policy-security] claim IDs appear in logs → owner: @sec\n')
  const r = approve()
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /resolve the concern\(s\) in feat\/design\.md/)
  assert.match(r.stderr, /claim IDs appear in logs/)
  assert.match(sdlc(repo, ['status']).stdout, /^open: feat\/design\.md: concern: \[policy-security\] claim IDs appear in logs/m)
})

test('approve accepts a design whose concerns are all resolved', () => {
  design('## Concerns\n- [policy-security] claim IDs appear in logs → owner: @sec → resolved: masked at the logger (@sec)\n')
  const r = approve()
  assert.equal(r.code, 0, r.stderr)
})

test('a design written before Concerns existed (no section) is approved as before', () => {
  design('')
  const r = approve()
  assert.equal(r.code, 0, r.stderr)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/concerns.spec.ts`
Expected: FAIL (`unresolvedConcerns` is not exported).

- [ ] **Step 3: Implement**

In `scripts/model.ts`, directly after `openQuestions`:

```ts
// Concerns a spec, plan or design flags against a policy skill: bullets under `## Concerns` other than "none" without a
// `resolved:`. Approval needs none. A document with no Concerns section has none, so changes begun before it keep working.
export function unresolvedConcerns(text: string): string[] {
  const section = /^##\s+Concerns\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(text)?.[1] ?? ''
  return section.split('\n').filter(l => /^\s*[-*]\s+/.test(l)).map(l => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(l => l && !/^none\.?$/i.test(l) && !/\bresolved:/i.test(l))
}
```

In `scripts/sdlc.ts`, add `unresolvedConcerns` to the `./model.ts` import, and directly after the open-questions `if (open.length) { ... }` block in `cmdApprove`:

```ts
  const concerns = ['spec', 'plan', 'design'].includes(stage) ? unresolvedConcerns(read(file)) : []
  if (concerns.length) fail(`resolve the concern(s) in ${slug}/${artifact} with their policy owners before approving: add " → resolved: <decision> (<owner>)" to each:\n${concerns.map(c => `  - ${c}`).join('\n')}`)
```

In `scripts/stale.ts`, add `unresolvedConcerns` to the `./model.ts` import and change `openItems` to:

```ts
export function openItems(slug: string): string[] {
  return ['intent.md', 'spec.md', 'design.md', 'plan.md'].flatMap(f => {
    const text = read(path.join(CHANGES, slug, f))
    return [...openQuestions(text).map(q => `${slug}/${f}: ${q}`), ...(f === 'intent.md' ? [] : unresolvedConcerns(text).map(c => `${slug}/${f}: concern: ${c}`))]
  })
}
```

In `templates/design-format.md`:
- in the **spec.md** sentence, insert `` `## Concerns`; `` before `` `## Open questions`; ``;
- in the **plan.md and design.md** list, insert this bullet directly before the `## Risks & rollback` bullet:

```
- `## Concerns`: one bullet per conflict with, or gap against, a policy skill (`.claude/skills/policy-*/SKILL.md`): ``- [policy-<area>] <concern> → owner: <its owner:>``. When the owner decides, append `` → resolved: <decision> (<owner>)``. Write `none` if none. Approval is refused while a concern has no `resolved:`.
```

- [ ] **Step 4: Run the tests and the suites that read approvals and status**

Run: `node --disable-warning=ExperimentalWarning --test scripts/concerns.spec.ts scripts/stale.spec.ts scripts/graph.spec.ts scripts/model.spec.ts scripts/size.spec.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/model.ts scripts/sdlc.ts scripts/stale.ts templates/design-format.md scripts/concerns.spec.ts
git commit -m "feat: a policy concern blocks approval until its owner's decision is recorded" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Skills read inbox files and policy skills; `/rig:intent` writes an inbox file; `--plan-only`

**Files:**
- Create: `skills/intent/SKILL.md`
- Modify: `skills/start/SKILL.md`, `skills/design/SKILL.md`, `skills/plan/SKILL.md`, `skills/spec/SKILL.md`
- Test: `scripts/policy.spec.ts` (create)

**Interfaces:**
- Consumes: `new --source` (Task 1); the `## Concerns` format (Task 4).
- Produces: `/rig:intent "<idea>"`; `/rig:start .sdlc/intent/<file>.md [--plan-only]`; skill text Task 7's workflow relies on (`--plan-only`).

- [ ] **Step 1: Write the failing tests**

Create `scripts/policy.spec.ts`:

```ts
// Stage 1 and 2 skills: the inbox, --plan-only, and policy skills that become ## Concerns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('start reads an inbox file, passes --source, and never builds with --plan-only', () => {
  const start = read('skills/start/SKILL.md')
  assert.match(start, /If the request is a file under `\.sdlc\/intent\/`/)
  assert.match(start, /--source <that path>/)
  assert.match(start, /`--plan-only`[^\n]*never build/)
  assert.match(start, /Tier S fast path\*\* \(not with `--plan-only`;/)
})

test('design, plan and spec apply policy skills and record conflicts as ## Concerns', () => {
  for (const s of ['design', 'plan', 'spec']) {
    const text = read(`skills/${s}/SKILL.md`)
    assert.match(text, /\.claude\/skills\/policy-\*\/SKILL\.md/, s)
    assert.match(text, /## Concerns/, s)
  }
})

test('the intent skill writes a draft inbox file in the playbook form and hands it to the product owner', () => {
  const text = read('skills/intent/SKILL.md')
  assert.match(text, /^name: intent$/m)
  assert.match(text, /\.sdlc\/intent\/<kebab-name>\.md/)
  assert.match(text, /status: draft/)
  for (const h of ['## Problem', '## Proposed outcome', '## Affected users and systems', '## Constraints', '## Open questions']) assert.ok(text.includes(h), h)
  assert.match(text, /status: accepted/)
  assert.ok(text.split('\n').length <= 60)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/policy.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Edit `skills/start/SKILL.md`**

- Directly after the line `Request: $ARGUMENTS`, add a blank line and:

```
If the request ends with `--plan-only` (the rig-spec workflow passes it), drop it from the request and stop after intent.md, and design.md for a feature or greenfield change: never build in that run, whatever the tier.
```

- In `## New change` step 3 (**Classify.**), directly after the issue-reference bullet, add:

```
   - If the request is a file under `.sdlc/intent/`, read it: its body is the request, and its `type:` and `tier:` frontmatter, when present, are the classification. Pass `--source <that path>` to `new` in step 4 and carry its sections into intent.md.
```

- In step 5, change `5. **Tier S fast path** (any type except spike and greenfield).` to `5. **Tier S fast path** (not with \`--plan-only\`; any type except spike and greenfield).` — the test pins `Tier S fast path** (not with \`--plan-only\`;`.

- [ ] **Step 4: Edit `skills/design/SKILL.md`, `skills/plan/SKILL.md`, `skills/spec/SKILL.md`**

In each, append to the end of step 2 (**Draft.**):

```
 Apply every policy skill (`.claude/skills/policy-*/SKILL.md`; list them with Glob and give the architect their paths): each conflict or gap is a `## Concerns` bullet naming the policy and its `owner:`.
```

In `skills/design/SKILL.md` step 5 (**Decide, do not stall.**), append: ` A \`## Concerns\` bullet blocks approval until it carries \`resolved:\`; tell the person which owner to ask.`

- [ ] **Step 5: Create `skills/intent/SKILL.md`**

````
---
name: intent
description: Capture an idea as an intent file in the inbox (.sdlc/intent/), in the originator's own words, before any change exists. For product owners and anyone with an idea; no git or code knowledge needed. Use when someone describes a problem or an idea to build, not a task to start now.
argument-hint: '"<the idea, in your own words>"'
effort: medium
allowed-tools: Read, Write, Glob, AskUserQuestion
---
# Capture an intent

Idea: $ARGUMENTS

1. **Listen first.** Restate the idea in two lines. Then ask what an analyst would, at most three questions in one AskUserQuestion: who is affected, what better looks like (how we will know), and what is out of scope or constrained (data, security, existing systems). Skip any the idea already answers.
2. **Write** `.sdlc/intent/<kebab-name>.md` (lowercase letters, digits and hyphens; check with Glob that the name is free), at most 40 lines, in the originator's words:

   ```
   ---
   status: draft
   author: <name and role>
   created: <today, YYYY-MM-DD>
   ---
   # Intent: <title>

   ## Problem
   ## Proposed outcome
   ## Affected users and systems
   ## Constraints
   ## Open questions
   ```

   Add `type:` and `tier:` to the frontmatter only if the originator knows them; otherwise the engineer or the rig-spec workflow classifies the idea.
3. **Read it back.** Show the file and ask the originator to correct anything misunderstood; edit until they agree.
4. **Hand over.** It is a draft. The product owner accepts it by setting `status: accepted` and merging it to the trunk in a pull request the inbox's code owners review. With the rig-spec workflow installed, that merge opens a pull request with intent.md and design.md; otherwise an engineer runs `/rig:start .sdlc/intent/<kebab-name>.md`.

End with: `Next: open a pull request with .sdlc/intent/<kebab-name>.md (or ask an engineer to)`.
````

- [ ] **Step 6: Run the skill tests and the suites that read skills**

Run: `node --disable-warning=ExperimentalWarning --test scripts/policy.spec.ts scripts/models.spec.ts scripts/review.spec.ts scripts/vendor.spec.ts scripts/size.spec.ts`
Expected: PASS (every skill ≤ 60 lines; `wc -l skills/*/SKILL.md`). `models.spec.ts` requires the Models line only in skills that name `rig:architect`, `rig:implementer` or `rig:reviewer`; `intent` names none.

- [ ] **Step 7: Commit**

```bash
git add skills scripts/policy.spec.ts
git commit -m "feat: /rig:intent captures an idea; start reads inbox files and --plan-only; design applies policy skills" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `init` scaffolds a `policy-security` skill to edit

**Files:**
- Create: `templates/policy-security.md`
- Modify: `scripts/sdlc.ts` (`COMMANDS.init`, and a small `scaffoldPolicy` function above `COMMANDS`)
- Test: `scripts/policy.spec.ts` (append)

**Interfaces:**
- Consumes: `PLUGIN_ROOT`, `ROOT`, `exists`, `sanctionWrites`, `out` from core.
- Produces: `.claude/skills/policy-security/SKILL.md` in a project after `sdlc.ts init`, never overwritten; `sdlc.ts new` (which calls `cmdInit` internally) does not scaffold it.

- [ ] **Step 1: Write the failing test**

Append to `scripts/policy.spec.ts` (add `import { makeRepo, sdlc, write } from './testkit.ts'` at the top):

```ts
test('init scaffolds policy-security once, with owner and source to fill in; new does not', () => {
  const repo = makeRepo()
  const file = path.join(repo, '.claude/skills/policy-security/SKILL.md')
  sdlc(repo, ['new', 'x', '--type', 'chore', '--tier', 'S'])
  assert.equal(fs.existsSync(file), false, 'new initialises .sdlc but writes no policy skill')
  const r = sdlc(repo, ['init'])
  assert.match(r.stdout, /wrote \.claude\/skills\/policy-security\/SKILL\.md: set its owner and source/)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /^name: policy-security$/m)
  assert.match(text, /^owner: /m)
  assert.match(text, /^source: /m)
  write(repo, '.claude/skills/policy-security/SKILL.md', 'mine\n')
  sdlc(repo, ['init'])
  assert.equal(fs.readFileSync(file, 'utf8'), 'mine\n', 'an existing policy skill is never overwritten')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test --test-name-pattern="policy-security" scripts/policy.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Create `templates/policy-security.md`**

```
---
name: policy-security
description: The security policy for this repository. Apply it whenever a spec, plan, design or change touches an endpoint, authentication, authorization, input handling, logging, secrets or personal data.
owner: <the team or person who owns this policy>
source: <link to the written policy this skill follows>
---
# Security policy

Applies to every spec, plan, design and change here. Where a change cannot meet a rule, do not work around it: record a `## Concerns` bullet naming this policy and its owner.

1. **Authentication:** every new endpoint requires the existing authentication; no anonymous route except health checks.
2. **Authorization:** every read or write of another user's data checks that the caller may do it.
3. **Input:** validate request bodies and parameters against their schema and reject unknown fields.
4. **Secrets and personal data:** never in code, logs, error messages or test fixtures.
5. **Audit:** every state-changing operation records who did what, to what, and when.

Edit this file to match your written policy, set `owner` and `source`, and have the owner approve changes to it like code.
```

- [ ] **Step 4: Implement**

In `scripts/sdlc.ts`, above `const COMMANDS`, add:

```ts
// A starting policy skill for design and review to apply; only the person-run init writes it, and never over an existing one.
function scaffoldPolicy(): string {
  const rel = '.claude/skills/policy-security/SKILL.md'
  const src = path.join(PLUGIN_ROOT, 'templates', 'policy-security.md')
  if (exists(path.join(ROOT, rel)) || !exists(src)) return ''
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true })
  fs.copyFileSync(src, path.join(ROOT, rel))
  sanctionWrites([rel])
  return `wrote ${rel}: set its owner and source`
}
```

and change the `COMMANDS` entry `init: cmdInit,` to `init: args => { cmdInit(args); const note = scaffoldPolicy(); if (note) out(note) },`.

- [ ] **Step 5: Run the tests**

Run: `node --disable-warning=ExperimentalWarning --test scripts/policy.spec.ts scripts/sdlc.spec.ts scripts/vendor.spec.ts scripts/size.spec.ts && npm run typecheck`
Expected: PASS. If an existing init test asserts init's exact stdout, extend it for the new line.

- [ ] **Step 6: Commit**

```bash
git add templates/policy-security.md scripts/sdlc.ts scripts/policy.spec.ts
git commit -m "feat: init scaffolds a policy-security skill with an owner and source to fill in" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `rig-spec.yml` drafts accepted intents in a read-only model job and publishes from a model-free job

**Files:**
- Create: `templates/rig-spec.yml`
- Test: `scripts/rigspec.spec.ts` (create)

**Interfaces:**
- Consumes: `sdlc.ts inbox --pending --json` and `inbox --json` (Task 2: `file`, `change`, `model`); `specBranch` naming `sdlc/intent-<name>` (Task 2); `/rig-start <path> --plan-only` (Task 5).
- Produces: a workflow template projects copy to `.github/workflows/`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/rigspec.spec.ts`:

```ts
// rig-spec.yml: the publish job's file check runs as written in the workflow; the privilege split is in the text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const yml = fs.readFileSync(path.join(import.meta.dirname, '..', 'templates/rig-spec.yml'), 'utf8')

// The publish check, cut from the workflow between its markers and run with bash -e like GitHub does.
function publishCheck(setup: (dir: string) => void): { code: number | null; slug: string; err: string } {
  const start = yml.indexOf('# publish-check:start')
  const end = yml.indexOf('# publish-check:end')
  assert.ok(start >= 0 && end > start, 'the workflow carries both publish-check markers')
  const script = yml.slice(start, end).split('\n').map(l => l.replace(/^ {10}/, '')).join('\n')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-spec-'))
  fs.mkdirSync(path.join(work, 'change'))
  setup(path.join(work, 'change'))
  const outFile = path.join(work, 'out')
  const r = spawnSync('bash', ['-e', '-c', script], { cwd: work, env: { ...process.env, GITHUB_OUTPUT: outFile }, encoding: 'utf8' })
  return { code: r.status, slug: fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '', err: r.stdout + r.stderr }
}
const folder = (dir: string, slug: string, files: string[]) => {
  fs.mkdirSync(path.join(dir, slug))
  for (const f of files) fs.writeFileSync(path.join(dir, slug, f), 'x\n')
}

test('publish accepts one change folder of rig files and outputs its name', () => {
  const r = publishCheck(d => folder(d, 'claims-status', ['intent.md', 'design.md', 'ratchet.json', 'events.jsonl']))
  assert.equal(r.code, 0, r.err)
  assert.equal(r.slug, 'slug=claims-status')
})

test('publish refuses a script, a symlink, a nested folder, a second change folder and a bad name', () => {
  assert.notEqual(publishCheck(d => folder(d, 'a', ['intent.md', 'run.sh'])).code, 0, 'script')
  assert.notEqual(publishCheck(d => { folder(d, 'a', ['intent.md']); fs.symlinkSync('/etc/passwd', path.join(d, 'a', 'design.md')) }).code, 0, 'symlink')
  assert.notEqual(publishCheck(d => { folder(d, 'a', ['intent.md']); fs.mkdirSync(path.join(d, 'a', 'sub')) }).code, 0, 'nested folder')
  assert.notEqual(publishCheck(d => { folder(d, 'a', ['intent.md']); folder(d, 'b', ['intent.md']) }).code, 0, 'two folders')
  assert.notEqual(publishCheck(d => folder(d, 'Bad_Name', ['intent.md'])).code, 0, 'bad name')
})

test('privilege split: read-only model job with no persisted credentials; the publish job runs no model', () => {
  assert.match(yml, /^permissions:\n  contents: read$/m)
  const [beforePublish = '', publish = ''] = yml.split(/^  publish:$/m)
  assert.match(beforePublish, /persist-credentials: false/)
  assert.match(beforePublish, /anthropics\/claude-code-action@/)
  assert.doesNotMatch(publish, /claude-code-action|claude -p/)
  assert.match(publish, /contents: write/)
  assert.match(publish, /pull-requests: write/)
})

test('the model job never builds and edits only change folders', () => {
  assert.match(yml, /\/rig-start \.sdlc\/intent\/\$\{\{ matrix\.intent\.file \}\} --plan-only/)
  assert.match(yml, /Edit\(\.\/\.sdlc\/changes\/\*\*\)/)
  assert.doesNotMatch(yml, /--allowedTools "[^"]*\b(?:Edit|Write|Bash),/)
  assert.match(yml, /inbox --pending --json/)
  assert.match(yml, /sdlc\/intent-\$\{FILE%\.md\}/)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --disable-warning=ExperimentalWarning --test scripts/rigspec.spec.ts`
Expected: FAIL (ENOENT on templates/rig-spec.yml).

- [ ] **Step 3: Create `templates/rig-spec.yml`**

```yaml
# rig-spec: when an accepted intent lands in .sdlc/intent/ on the trunk, draft its change (intent.md and, for a feature,
# design.md) and open a pull request for the product owner to review. Copy to .github/workflows/ and list it in CODEOWNERS.
# Auth: set ONE repository secret, CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY.
# Privilege split, as in rig-review.yml: the draft job runs the model with a read-only token and no persisted credentials and
# hands the change folder over as an artifact; the publish job runs no model, accepts only rig's own files in one change
# folder, then pushes a branch and opens the pull request. The draft job passes --plan-only, so nothing is ever built here.
# Residual risk: the draft job holds the Anthropic credential and the model runs rig's commands there (the start and design
# skills call sdlc.ts, and `check --at plan` runs declared commands). It cannot push. Run it on trusted-team repos.
# Pin setup-node, upload-artifact and download-artifact to commit SHAs with Dependabot or Renovate, as the other actions are.
name: rig-spec
on:
  push:
    branches: [main]
    paths: ['.sdlc/intent/**']
concurrency:
  group: rig-spec
  cancel-in-progress: false
permissions:
  contents: read
jobs:
  pick:
    runs-on: ubuntu-latest
    outputs:
      pending: ${{ steps.pick.outputs.pending }}
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22.18'
      - name: Accepted intents with no change and no rig-spec branch yet
        id: pick
        run: echo "pending=$(node --disable-warning=ExperimentalWarning .sdlc/bin/sdlc.ts inbox --pending --json)" >> "$GITHUB_OUTPUT"
  draft:
    needs: pick
    if: needs.pick.outputs.pending != '[]'
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        intent: ${{ fromJSON(needs.pick.outputs.pending) }}
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22.18'
      - name: Model for the intent's tier (Opus when the tier is unknown)
        id: model
        env:
          MODEL: ${{ matrix.intent.model }}
        run: |
          case "$MODEL" in haiku) id=claude-haiku-5-5 ;; sonnet) id=claude-sonnet-5-5 ;; *) id=claude-opus-5-5 ;; esac
          echo "id=$id" >> "$GITHUB_OUTPUT"
      - uses: anthropics/claude-code-action@ed670b4cf9de2a5a570d130d2f6197b9e543cd64 # v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          github_token: ${{ github.token }}
          claude_args: >-
            --model ${{ steps.model.outputs.id }} --max-turns 60
            --allowedTools "Read(./**),Grep,Glob,Agent,Skill,Edit(./.sdlc/changes/**),Bash(node --disable-warning=ExperimentalWarning .sdlc/bin/sdlc.ts *)"
            --disallowedTools "WebFetch,WebSearch,AskUserQuestion"
          prompt: /rig-start .sdlc/intent/${{ matrix.intent.file }} --plan-only
      - name: Hand the change folder over
        env:
          FILE: ${{ matrix.intent.file }}
        run: |
          slug=$(node --disable-warning=ExperimentalWarning .sdlc/bin/sdlc.ts inbox --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s).find(x=>x.file===process.argv[1]);process.stdout.write((e&&e.change)||"")})' "$FILE")
          [ -n "$slug" ] || { echo "::error::no change names .sdlc/intent/$FILE as its source"; exit 1; }
          mkdir -p handover && cp -R ".sdlc/changes/$slug" handover/
      - uses: actions/upload-artifact@v4
        with:
          name: rig-spec-${{ matrix.intent.file }}
          path: handover/
  publish:
    needs: [pick, draft]
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    strategy:
      fail-fast: false
      matrix:
        intent: ${{ fromJSON(needs.pick.outputs.pending) }}
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          fetch-depth: 0
      - uses: actions/download-artifact@v4
        with:
          name: rig-spec-${{ matrix.intent.file }}
          path: change
      - name: Accept only rig's own files in one change folder (no model runs in this job)
        id: check
        run: |
          # publish-check:start
          dir=change
          set -- "$dir"/*
          [ "$#" = 1 ] && [ -d "$1" ] && [ ! -L "$1" ] || { echo "::error::expected exactly one change folder"; exit 1; }
          slug=$(basename "$1")
          printf '%s' "$slug" | grep -Eq '^[a-z0-9][a-z0-9-]{1,60}$' || { echo "::error::bad change name: $slug"; exit 1; }
          for f in "$dir/$slug"/* "$dir/$slug"/.[!.]*; do
            [ -e "$f" ] || [ -L "$f" ] || continue
            if [ -L "$f" ] || [ -d "$f" ]; then echo "::error::refusing $f"; exit 1; fi
            case "$(basename "$f")" in intent.md|design.md|spec.md|plan.md|ratchet.json|events.jsonl) ;; *) echo "::error::refusing $f"; exit 1 ;; esac
          done
          echo "slug=$slug" >> "$GITHUB_OUTPUT"
          # publish-check:end
      - name: Push the branch and open the pull request
        env:
          GH_TOKEN: ${{ github.token }}
          FILE: ${{ matrix.intent.file }}
          SLUG: ${{ steps.check.outputs.slug }}
        run: |
          branch="sdlc/intent-${FILE%.md}"
          git switch -c "$branch"
          mkdir -p .sdlc/changes && cp -R "change/$SLUG" .sdlc/changes/
          git add ".sdlc/changes/$SLUG"
          git -c user.name=rig-spec -c user.email=rig-spec@users.noreply.github.com commit -m "spec: draft $SLUG from .sdlc/intent/$FILE"
          git push origin "$branch"
          gh pr create --head "$branch" --title "spec: $SLUG" --body "Drafted by rig-spec from .sdlc/intent/$FILE. Review intent.md and design.md and resolve every ## Concerns line with its owner; then approve with /rig-approve $SLUG design and an engineer runs /rig-start $SLUG."
```

- [ ] **Step 4: Run the tests**

Run: `node --disable-warning=ExperimentalWarning --test scripts/rigspec.spec.ts scripts/size.spec.ts`
Expected: PASS. (The symlink case needs a POSIX file system; the suite already runs on macOS and Linux only for the shell tests.)

- [ ] **Step 5: Commit**

```bash
git add templates/rig-spec.yml scripts/rigspec.spec.ts
git commit -m "feat: rig-spec drafts accepted intents in a read-only model job and publishes from a model-free job" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation and the full verification pass

**Files:**
- Modify: `README.md`, `DESIGN.md`, `CHANGELOG.md`, `SECURITY.md`

**Interfaces:**
- Consumes: everything above. Docs must describe what the code does (read `git log --oneline main..HEAD`).

- [ ] **Step 1: README**

- In the command atlas "Drive the change" table, add a row for `/rig:intent "<idea>"` (anyone with an idea; writes a draft `.sdlc/intent/<name>.md` for a product owner to accept), and extend the `/rig:start` row: `or an inbox file (.sdlc/intent/<name>.md); --plan-only stops before any build`.
- Add `inbox` to "The script underneath" list.
- Add a short subsection **Intent inbox and policy skills** (≤ 15 lines): the inbox and its statuses (`draft | accepted | closed`, `shipped` derived); accepting is a merge reviewed by the inbox's code owners (add `/.sdlc/intent/` to the CODEOWNERS example if the README carries one); `templates/rig-spec.yml` (what each job may do, `--plan-only`, one secret); policy skills (`.claude/skills/policy-<area>/SKILL.md` with `owner` and `source`; `init` scaffolds `policy-security`); `## Concerns` blocks approval until `resolved:`. Note that the intent skill can be uploaded to claude.ai for people who don't use Claude Code.
- Update the skills count in "What is in the box" (`skills/` (15) → (16)).

- [ ] **Step 2: DESIGN.md**

- §3 Architecture: add `intent` to the skills list.
- §5 Artifacts tree: add `├── intent/  <name>.md  ideas before a change exists; status draft|accepted|closed (shipped is derived)`.
- §7 Measurement: append `inbox_survival` (accepted or shipped out of decided inbox ideas, beside `intent_survival` which counts changes) and `intent_churn_after_design`.

- [ ] **Step 3: CHANGELOG**

Under `## Unreleased`, add at the top (followed by a blank line before the existing text):

```
- **Intent inbox.** `.sdlc/intent/<name>.md` holds ideas before a change exists; people write `status: draft | accepted | closed`, and `shipped` is derived from the change whose intent.md names the file as `source:` (`sdlc.ts new --source`). `sdlc.ts inbox [--pending] [--json]` lists them; `status` names accepted ones with no change; `metrics` adds `inbox_survival` and `intent_churn_after_design`. `/rig:intent` captures an idea in the playbook's form; `/rig:start .sdlc/intent/<name>.md` starts a change from one, and `--plan-only` stops before any build.
- **Policy concerns.** Design, plan and spec apply every `.claude/skills/policy-*/SKILL.md` and record each conflict as a `## Concerns` bullet naming the policy's `owner:`; approval is refused until each carries `resolved:` (a document without the section approves as before). `init` scaffolds `policy-security` to edit.
- **rig-spec workflow** (`templates/rig-spec.yml`): an accepted intent merged to the trunk is drafted by a read-only model job (`/rig-start … --plan-only`, model by the intent's tier, Opus when unknown) and published by a model-free job that accepts only rig's change files in one folder and opens a PR on `sdlc/intent-<name>`; an intent whose branch exists is not drafted twice.
- The harness line cap is 7,900.
```

- [ ] **Step 4: SECURITY.md**

Add one row or bullet (matching the file's structure) for `rig-spec.yml`: the draft job holds the Anthropic credential and runs rig's commands with a read-only token and no persisted git credentials; the publish job runs no model and accepts only `intent.md`, `design.md`, `spec.md`, `plan.md`, `ratchet.json`, `events.jsonl` in one change folder (no symlinks, no subfolders); run it on trusted-team repos; inbox files are model-writable (`Edit(.sdlc/**)`), so CODEOWNERS on `/.sdlc/` is what makes acceptance a person's decision.

- [ ] **Step 5: Full verification**

```bash
npm run typecheck
node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts
claude plugin validate .claude-plugin/plugin.json
wc -l skills/*/SKILL.md | sort -n | tail -3
node --disable-warning=ExperimentalWarning --test scripts/size.spec.ts
```

Expected: typecheck clean; every test passes; the plugin validates; no skill over 60 lines; the size test passes under 7,900. Paste the outputs into the report.

- [ ] **Step 6: Commit**

```bash
git add README.md DESIGN.md CHANGELOG.md SECURITY.md
git commit -m "docs: intent inbox, policy concerns and the rig-spec workflow" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
