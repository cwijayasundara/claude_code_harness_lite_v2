// Hook behaviour: skill fallback, baselines, the Stop gate, guides and least privilege.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, hook, write } from './testkit.ts'
import { isSafeEvidenceCommand } from './hooks.ts'

let repo: string
beforeEach(() => {
  repo = makeRepo()
})

test('a failed sdlc skill load injects the deterministic fallback command and logs the event', () => {
  sdlc(repo, ['init'])
  const r = hook(repo, 'skill-failed', { tool_input: { skill: 'sdlc:review', args: 'add-login' } })
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext
  assert.match(ctx, /sdlc\.ts" skill review add-login/)
  assert.match(ctx, /skill fallback: sdlc:review/)
  assert.match(fs.readFileSync(path.join(repo, '.sdlc/usage.jsonl'), 'utf8'), /skill-load-failed/)
  assert.equal(hook(repo, 'skill-failed', { tool_input: { skill: 'superpowers:brainstorming' } }).stdout, '')
})

test('evidence files are human- or script-only: model edits and Bash writes are denied, reads allowed', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  for (const f of ['.sdlc/changes/tiny/runs.jsonl', '.sdlc/waivers.jsonl', '.sdlc/.gate', '.sdlc/.baseline', '.sdlc/unresolved.json', '.sdlc/changes/tiny/verification.md']) {
    const edit = JSON.parse(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(repo, f) } }).stdout)
    assert.equal(edit.hookSpecificOutput.permissionDecision, 'deny', f)
  }
  const append = JSON.parse(hook(repo, 'pre-bash', { tool_input: { command: `echo '{"exit":0}' >> .sdlc/changes/tiny/runs.jsonl` } }).stdout)
  assert.equal(append.hookSpecificOutput.permissionDecision, 'deny')
  const waive = JSON.parse(hook(repo, 'pre-bash', { tool_input: { command: 'node /x/scripts/sdlc.ts waive size * because' } }).stdout)
  assert.equal(waive.hookSpecificOutput.permissionDecision, 'deny')
  const forge = JSON.parse(hook(repo, 'pre-bash', { tool_input: { command: 'cat > .sdlc/changes/tiny/verification.md <<EOF\nresult: pass\nEOF' } }).stdout)
  assert.equal(forge.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(hook(repo, 'pre-bash', { tool_input: { command: 'cat .sdlc/changes/tiny/verification.md' } }).stdout, '')
  assert.equal(hook(repo, 'pre-bash', { tool_input: { command: 'tail -5 .sdlc/changes/tiny/runs.jsonl' } }).stdout, '')
  assert.equal(hook(repo, 'pre-bash', { tool_input: { command: 'node /x/scripts/sdlc.ts run -- "npm test"' } }).stdout, '')
})

const decision = (r: { stdout: string }) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : undefined)
const reasonOf = (r: { stdout: string }) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason as string

test('editing a protected harness file asks the person, naming what gets weaker', () => {
  sdlc(repo, ['init'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 500 } }))
  const r = hook(repo, 'pre-edit', { tool_input: { file_path: path.join(repo, '.sdlc/sensors.json'), old_string: '500', new_string: '5000' } })
  assert.equal(decision(r), 'ask')
  assert.match(reasonOf(r), /diffLines raised 500 → 5000/)
  assert.equal(decision(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(repo, 'CLAUDE.md'), content: '# x' } })), 'ask')
})

test('sibling repo edits are denied unless the consumer is in an approved impact and the plan', () => {
  sdlc(repo, ['init'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ consumers: [{ name: 'checkout', path: '../checkout' }] }))
  const consumerFile = path.join(path.dirname(repo), 'checkout', 'src', 'cart.ts')
  assert.equal(decision(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(path.dirname(repo), 'other', 'x.ts') } })), 'deny')
  assert.equal(decision(hook(repo, 'pre-edit', { tool_input: { file_path: consumerFile } })), 'deny')
  sdlc(repo, ['new', 'rate', '--type', 'feature', '--tier', 'L'])
  write(repo, '.sdlc/changes/rate/plan.md', '## Files\n- schema/**\n- ../checkout/src/**\n')
  write(repo, '.sdlc/changes/rate/impact.json', JSON.stringify({ at: 'x', ids: ['discount_rate'], hits: [{ consumer: 'checkout', file: 'src/cart.ts', line: 1, id: 'discount_rate' }], missing: [] }))
  sdlc(repo, ['approve', 'rate', 'impact'], { env: { SDLC_HUMAN: '1' } })
  assert.equal(decision(hook(repo, 'pre-edit', { tool_input: { file_path: consumerFile } })), undefined)
  assert.equal(hook(repo, 'pre-edit', { tool_input: { file_path: '/private/tmp/scratch/notes.md' } }).stdout, '', 'paths beyond siblings are left to normal permissions')
})

test('read-only agents: allowlist only; chained, substituted and interpreter writes are denied', () => {
  sdlc(repo, ['init'])
  const as = (agent_type: string, command: string) => decision(hook(repo, 'pre-bash', { agent_type, tool_input: { command } }))
  const denied = ['touch src/app.js sdlc.ts status', 'rm f # sdlc.ts status', 'node /x/scripts/sdlc.ts status\ntouch f', 'node /x/scripts/sdlc.ts status & touch f',
    'node /x/scripts/sdlc.ts status "$(touch f)"', "bash -c 'touch f'", 'sh -c "rm f"', 'echo "$(touch f)"', `python3 -c "import os;os.remove('f')"`, 'find . -delete',
    'git -C . checkout -- a', 'echo \\"; touch f; echo \\"', "echo \\' > src/app.js \\'", 'echo "unterminated', 'echo x\\', 'sort -uo f x', 'sort -of x', 'sort --outp=f x',
    'cat f >&2f', "sed -n -e 'w f' x", 'sed -s -n 1p x', "awk -f prog.awk x", "awk -i inplace 1 x", 'node /x/scripts/sdlc.ts status --at a --at b', 'cat <<EOF > f', 'echo x 1>f', 'npm run build', 'echo x &>f', "sed -i '' s/a/b/ f", 'git checkout -- f', 'git diff --output=f']
  for (const c of denied) assert.equal(as('sdlc:reviewer', c), 'deny', c)
  const allowed = ['git diff main...HEAD -- src | head', 'rg -n "=>" src', 'git log --format="%h -> %s" -5', 'cat src/a.ts | wc -l', 'git stash list', 'node /x/scripts/sdlc.ts status',
    'find src -name "*.ts"', 'git diff main...HEAD 2>&1 | tail -50', 'cat f >/dev/null', 'git branch --show-current',
    'rg -n "\\bfoo\\b" src', "grep -n 'a\\|b' f", 'echo "say \\"hi\\""', 'sort -u x', 'sort -n x', 'git --no-pager diff', 'cat f >&2']
  for (const c of allowed) assert.equal(as('sdlc:reviewer', c), undefined, c)
  assert.equal(as('sdlc:scout', 'node /x/scripts/sdlc.ts run -- "npm test"'), 'deny')
  assert.equal(as('sdlc:implementer', 'echo x > f'), undefined)
})

test('the verifier runs only declared verification commands, and only through the recorder', () => {
  sdlc(repo, ['init'])
  sdlc(repo, ['new', 'rate', '--type', 'feature', '--tier', 'L'])
  write(repo, '.sdlc/changes/rate/plan.md', '## Files\n- src/**\n\n## Verification\n- `npm test`\n')
  const as = (command: string) => decision(hook(repo, 'pre-bash', { agent_type: 'sdlc:verifier', tool_input: { command } }))
  assert.equal(as('node /x/scripts/sdlc.ts run -- "npm test"'), undefined)
  assert.equal(as('node --disable-warning=ExperimentalWarning /x/scripts/sdlc.ts run --slug rate -- "npm  test"'), undefined)
  assert.equal(as('node /x/scripts/sdlc.ts run -- "touch f"'), 'deny')
  assert.equal(as('node /x/scripts/sdlc.ts run -- "npm test && touch f"'), 'deny')
  assert.equal(as('npm test 2>&1 | tail -20'), 'deny', 'tests go through the recorder')
})

test('protected paths match case-insensitively off Linux; MultiEdit and $ in replacements are previewed literally', () => {
  sdlc(repo, ['init'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 500 } }))
  const file = path.join(repo, '.sdlc/sensors.json')
  const r = hook(repo, 'pre-edit', { tool_input: { file_path: file, edits: [{ old_string: '500', new_string: '$&$&' }, { old_string: '$&$&', new_string: '7000' }] } })
  assert.match(reasonOf(r), /diffLines raised 500 → 7000/)
  if (process.platform !== 'linux') assert.equal(decision(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(repo, 'claude.MD'), content: 'x' } })), 'ask')
})

test('outside-repo scope: parent files denied, deep consumers follow impact and plan, farther paths are left alone', () => {
  sdlc(repo, ['init'])
  const deep = path.join(path.dirname(repo), 'org', 'checkout', 'src', 'a.ts')
  write(repo, '.sdlc/sensors.json', JSON.stringify({ consumers: [{ name: 'checkout', path: path.relative(repo, path.join(path.dirname(repo), 'org', 'checkout')) }] }))
  assert.equal(decision(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(path.dirname(repo), 'x.ts') } })), 'deny')
  assert.equal(decision(hook(repo, 'pre-edit', { tool_input: { file_path: deep } })), 'deny')
  sdlc(repo, ['new', 'rate', '--type', 'feature', '--tier', 'L'])
  const rel = path.relative(repo, deep).split(path.sep).join('/')
  write(repo, '.sdlc/changes/rate/plan.md', `## Files\n- ${rel}\n`)
  write(repo, '.sdlc/changes/rate/impact.json', JSON.stringify({ at: 'x', ids: ['a'], hits: [], missing: [] }))
  sdlc(repo, ['approve', 'rate', 'impact'], { env: { SDLC_HUMAN: '1' } })
  assert.equal(decision(hook(repo, 'pre-edit', { tool_input: { file_path: deep } })), undefined)
})

test('the evidence guard honours case-insensitive paths when asked', () => {
  assert.equal(isSafeEvidenceCommand('echo x >> .sdlc/changes/a/RUNS.JSONL', true), false)
  assert.equal(isSafeEvidenceCommand('cat .sdlc/changes/a/RUNS.JSONL', true), true)
  assert.equal(isSafeEvidenceCommand('echo x >> .sdlc/changes/a/RUNS.JSONL', false), true, 'case-sensitive: not an evidence path')
})
