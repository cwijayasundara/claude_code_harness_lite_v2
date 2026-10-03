// Hook behaviour: skill fallback, baselines, the Stop gate, guides and least privilege.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeRepo, sdlc, hook, write, gitIn } from './testkit.ts'
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
    'cat f >&2f', "sed -n -e 'w f' x", 'sed -s -n 1p x', "awk -f prog.awk x", "awk -i inplace 1 x", 'node /x/scripts/sdlc.ts status --at a --at b', 'cat <<EOF > f', 'echo x 1>f', 'npm run build', 'echo x &>f', "sed -i '' s/a/b/ f", 'git checkout -- f', 'git diff --output=f',
    // fix round 4: $'...' desync, comments hiding quotes, quoted/escaped/braced options, zsh-only execution
    "echo $'\\'' ; touch PWN1 ; echo '\\'", "echo $'\\'' ; echo hi > PWN2 ; echo '\\'", "cat x #'\ntouch PWN3\n#'",
    "sort '-o' PWN4 x", 'sort \\-o PWN4 x', 'sort {-o,PWN4} x', "sort '--output=PWN4' x", 'sort --out=PWN4 x', "sort --compress-program=sh x",
    "find . -name z '-delete'", 'find . -name z \\-exec touch PWN5 \\;', "find . -name z -exe'c' touch PWN5 ';'",
    "git diff '--output=PWN6'", 'git diff --out=PWN6', "git grep '-Otouch PWN7' x", 'git grep -nOtouch x', "rg '--pre=touch' x", 'rg --pre touch x',
    "sed '-i' s/a/b/ f", "sed -n 1p '-i' f", "sed -n '1p' f -i", "awk '-f' prog x", "awk 'BEGIN{print 1 > \"PWN8\"}'", "awk '@load \"inplace\"' x", 'awk -d x',
    'cat =(touch PWN9)', "ls *(e:'touch PWN10':)", 'ls *(+touch)', 'cat <(touch f)', 'cat $(touch f)', 'echo ${x:=1}', 'echo $HOME', 'echo "$HOME"', 'echo $"x"',
    '(touch f)', 'cat f; { touch f; }', 'cat <>PWN11', 'cat < f', 'echo x >| f', 'echo x >! f', 'echo x >> f', 'echo x 2>"/dev/null"x', 'echo x >/dev/nullx', 'echo x >&-',
    'cat x\n#c', 'printf -v PATH /tmp x', 'X=1 cat f', 'node /x/scripts/sdlc.ts run -- npm test \\; touch f', 'node /x/scripts/sdlc.ts status -x',
    `node '--eval=require("fs").writeFileSync("PWN12","")//sdlc.ts' status`, `node '--import=data:text/javascript,import fs from "fs";fs.writeFileSync("PWN13","")//sdlc.ts' status`, 'node /x/notsdlc.ts status']
  for (const c of denied) assert.equal(as('sdlc:reviewer', c), 'deny', c)
  const allowed = ['git diff main...HEAD -- src | head', 'rg -n "=>" src', 'git log --format="%h -> %s" -5', 'cat src/a.ts | wc -l', 'git stash list', 'node /x/scripts/sdlc.ts status',
    'find src -name "*.ts"', 'git diff main...HEAD 2>&1 | tail -50', 'cat f >/dev/null', 'git branch --show-current',
    'rg -n "\\bfoo\\b" src', "grep -n 'a\\|b' f", 'echo "say \\"hi\\""', 'sort -u x', 'sort -n x', 'git --no-pager diff', 'cat f >&2',
    'sort -k2 -t, f', "find . \\( -name a -o -name b \\) -print", 'cat f 2>/dev/null | head', 'cat f > /dev/null 2>&1', "sed -n '1,/x/p' f", "awk '{print $1}' f",
    'echo a$ b', 'rg -n "foo$" src', 'echo a#b', "echo 'a(b)c' \"{x}\"", 'git log --oneline -5', 'rg --pre-glob "*.gz" x', 'cat x \\\n f']
  for (const c of allowed) assert.equal(as('sdlc:reviewer', c), undefined, c)
  assert.equal(as('sdlc:scout', 'node /x/scripts/sdlc.ts run -- "npm test"'), 'deny')
  assert.equal(as('sdlc:reviewer', 'npm test 2>&1 | tail -5'), 'deny', 'bare npm is not allowlisted')
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
  assert.equal(as('node /x/scripts/sdlc.ts run -- "npm\ntest"'), 'deny', 'a newline would run npm and then test')
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

test('quotes and escapes cannot hide an evidence path from the guard (non-read-only agents)', () => {
  sdlc(repo, ['init'])
  const as = (command: string) => decision(hook(repo, 'pre-bash', { tool_input: { command } }))
  for (const c of [`echo '{}' >> .sdlc/changes/a/run"s".jsonl`, `echo '{}' >> .sdlc/changes/a/ru'ns'.jsonl`, `echo '{}' >> .sdlc/changes/a/run\\s.jsonl`,
    'printf x > .sdlc/approvals.json"l"', `cp x .sdlc/changes/a/run's'.jsonl`, `echo '{}' | tee -a ".sdlc/waivers.jsonl"`, `node /x/scripts/sdlc.ts ap'prove' a plan`,
    'git diff --output=.sdlc/changes/a/run"s".jsonl', 'echo x | tee -a .sdlc/changes/a/run{s,}.jsonl', 'tee .sdlc/{approvals,x}.jsonl', 'cp x .sdlc/changes/a/{runs,x}.jsonl', 'rm .sdlc/changes/a/run?.jsonl', 'truncate -s0 .sdlc/changes/a/run?.jsonl', 'echo x >| .sdlc/changes/a/run?.jsonl', 'echo x >| .sdlc/changes/a/runs.jsonl', 'echo "$(date)" >> .sdlc/approvals.json\\l'])
    assert.equal(as(c), 'deny', c)
  for (const c of ['git add src/a.js .sdlc/approvals.jsonl && git commit -m "feat: x"', 'cat .sdlc/approvals.jsonl', 'tail -5 .sdlc/changes/x/runs.jsonl',
    'node /x/scripts/sdlc.ts run -- "npm test"', 'git commit -m "rm > node" .sdlc/changes/a/runs.jsonl', "grep -c pass '.sdlc/changes/a/runs.jsonl'"])
    assert.equal(as(c), undefined, c)
})

const stop = () => hook(repo, 'stop', { session_id: 's1' })
const tamper = () => write(repo, 'test/a.test.js', "it.only('x', () => {})\n")

test('Stop is silent outside sdlc repos and on turns that changed no source', () => {
  write(repo, 'src/x.js', 'x\n')
  assert.equal(stop().stdout, '')
  sdlc(repo, ['init'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'1\')"' } }))
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  hook(repo, 'prompt-submit', {})
  write(repo, '.sdlc/STATE.md', '---\nchange:\n---\nnotes\n')
  assert.equal(stop().stdout, '')
  assert.ok(!fs.existsSync(path.join(repo, 'ran.txt')), 'no commands run on a no-op turn')
})

test('Stop blocks twice, then lets the turn end with a system message and unresolved.json; a fix clears it', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  tamper()
  for (const n of [1, 2]) {
    const out = JSON.parse(stop().stdout)
    assert.equal(out.decision, 'block')
    assert.match(out.reason, new RegExp(`attempt ${n}/2[\\s\\S]*test-tamper[\\s\\S]*test/a\\.test\\.js:1`))
  }
  const third = JSON.parse(stop().stdout)
  assert.match(third.systemMessage, /1 problem\(s\) unresolved after 2 attempts/)
  assert.ok(fs.existsSync(path.join(repo, '.sdlc/unresolved.json')))
  write(repo, 'test/a.test.js', "it('x', () => {})\n")
  assert.equal(stop().stdout, '')
  assert.ok(!fs.existsSync(path.join(repo, '.sdlc/unresolved.json')))
})

test('a vibe-coded turn with no active change records an ad-hoc change with a computed tier', () => {
  sdlc(repo, ['init'])
  hook(repo, 'prompt-submit', {})
  for (const f of ['a', 'b', 'c', 'd', 'e']) write(repo, `src/${f}.js`, `export const ${f} = 1\n`)
  stop()
  const status = sdlc(repo, ['status']).stdout
  assert.match(status, /▶ adhoc-\d{8}-\d{4}\s+chore\s+M/)
})

test('SubagentStop judges only files that agent edited, and runs no project commands', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'1\')"' } }))
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  hook(repo, 'prompt-submit', {})
  hook(repo, 'subagent-start', { agent_id: 'A', agent_type: 'sdlc:implementer' })
  write(repo, 'src/a.js', 'export const a = 1\n')
  hook(repo, 'post-edit', { agent_id: 'A', tool_input: { file_path: path.join(repo, 'src/a.js') } })
  tamper()
  assert.equal(hook(repo, 'subagent-stop', { agent_id: 'A', agent_type: 'sdlc:implementer' }).stdout, '')
  assert.ok(!fs.existsSync(path.join(repo, 'ran.txt')))
  assert.equal(JSON.parse(stop().stdout).decision, 'block', 'the main Stop still sees the other file')
})

test('a harness file changed by Bash blocks at Stop; the same change through Edit only warns', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 500 } }))
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  hook(repo, 'prompt-submit', {})
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 900 } }))
  assert.match(JSON.parse(stop().stdout).reason, /outside Write\/Edit/)
  hook(repo, 'prompt-submit', {})
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 950 } }))
  hook(repo, 'post-edit', { tool_input: { file_path: path.join(repo, '.sdlc/sensors.json') } })
  assert.equal(stop().stdout, '')
})

test('post-edit blocks a single edited file with exit 2 and records the edit', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  tamper()
  const r = hook(repo, 'post-edit', { tool_input: { file_path: path.join(repo, 'test/a.test.js') } })
  assert.equal(r.code, 2)
  assert.match(r.stderr, /test skipped or focused/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.sdlc/.gate'), 'utf8')).tool, ['test/a.test.js'])
})

test('a corrupt gate file never wedges the session', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  fs.writeFileSync(path.join(repo, '.sdlc/.gate'), '{not json')
  tamper()
  assert.equal(JSON.parse(stop().stdout).decision, 'block')
})

test('evidence guard: $-quote forms and glob targets cannot write evidence; reads of globs are fine', () => {
  sdlc(repo, ['init'])
  const as = (command: string) => decision(hook(repo, 'pre-bash', { tool_input: { command } }))
  for (const c of [`echo x >> .sdlc/changes/a/run$'s'.jsonl`, 'echo x >> .sdlc/changes/a/run$"s".jsonl', 'echo x >> .sdlc/changes/a/run?.jsonl',
    'cp x .sdlc/changes/a/run[s].jsonl', 'echo x > .sdlc/approval*.jsonl'])
    assert.equal(as(c), 'deny', c)
  for (const c of ['cat .sdlc/changes/a/run?.jsonl', 'ls .sdlc/changes/*/']) assert.equal(as(c), undefined, c)
})

test('SubagentStop without agent_id is ignored; a clean SubagentStop leaves main unresolved.json alone', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ fast: { test: 'node -e "process.exit(1)"' } }))
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  hook(repo, 'prompt-submit', {})
  write(repo, 'src/a.js', 'export const a = 1\n')
  assert.equal(hook(repo, 'subagent-stop', {}).stdout, '')
  assert.equal(JSON.parse(stop().stdout).decision, 'block', 'main still runs fast commands')
  stop()
  stop()
  assert.ok(fs.existsSync(path.join(repo, '.sdlc/unresolved.json')))
  hook(repo, 'subagent-start', { agent_id: 'B', agent_type: 'sdlc:implementer' })
  assert.equal(hook(repo, 'subagent-stop', { agent_id: 'B', agent_type: 'sdlc:implementer' }).stdout, '')
  assert.ok(fs.existsSync(path.join(repo, '.sdlc/unresolved.json')), 'a subagent never clears it')
})

test('a protected-only diff creates no ad-hoc change; contract edits are tier M', () => {
  sdlc(repo, ['init'])
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 500 } }))
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'cfg')
  hook(repo, 'prompt-submit', {})
  write(repo, '.sdlc/sensors.json', JSON.stringify({ limits: { diffLines: 900 } }))
  stop()
  assert.ok(!fs.existsSync(path.join(repo, '.sdlc/changes')) || fs.readdirSync(path.join(repo, '.sdlc/changes')).length === 0)
})

test('a gate file with wrongly typed fields never crashes the hooks', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  hook(repo, 'prompt-submit', {})
  fs.writeFileSync(path.join(repo, '.sdlc/.gate'), '{"blocks":null,"agents":null}')
  tamper()
  assert.equal(JSON.parse(stop().stdout).decision, 'block')
})

const contextOf = (r: { stdout: string }) => (r.stdout ? (JSON.parse(r.stdout).hookSpecificOutput?.additionalContext as string | undefined) : undefined)
const edit = (rel: string, session = 's1') => hook(repo, 'pre-edit', { session_id: session, tool_input: { file_path: path.join(repo, rel) } })

test('init copies the default guides into .sdlc/guides', () => {
  sdlc(repo, ['init'])
  assert.deepEqual(fs.readdirSync(path.join(repo, '.sdlc/guides')).sort(), ['contracts.md', 'engineering.md', 'testing.md'])
})

test('a guide is injected the first time a matching file is edited in a session, and again after compaction', () => {
  sdlc(repo, ['init'])
  assert.match(contextOf(edit('src/order.ts')) ?? '', /# Engineering rules/)
  assert.equal(contextOf(edit('src/other.ts')), undefined)
  assert.match(contextOf(edit('test/order.test.ts')) ?? '', /# Testing rules/)
  assert.match(contextOf(edit('schema/billing.sql')) ?? '', /# Contract rules/)
  assert.match(contextOf(edit('src/order.ts', 's2')) ?? '', /# Engineering rules/, 'a new session gets the guides again')
  hook(repo, 'session-start', { session_id: 's1', source: 'compact' })
  assert.match(contextOf(edit('src/order.ts')) ?? '', /# Engineering rules/)
  assert.equal(contextOf(edit('README.md', 's3')), undefined, 'ignored files get no engineering guide')
})

test('session start lists guide names without their bodies', () => {
  sdlc(repo, ['new', 'xx', '--type', 'chore', '--tier', 'S'])
  const ctx = JSON.parse(hook(repo, 'session-start', { session_id: 's1', source: 'startup' }).stdout).hookSpecificOutput.additionalContext
  assert.match(ctx, /Guides \(injected when you first touch matching files\): contracts, engineering, testing/)
  assert.doesNotMatch(ctx, /Iron rules/)
})

test('I2: the evidence guard is silent in repos without .sdlc/, even for same-named files', () => {
  for (const command of ['python train.py > results/runs.jsonl', 'echo x >> data/approvals.jsonl', 'cp a waivers.jsonl']) {
    assert.equal(hook(repo, 'pre-bash', { tool_input: { command } }).stdout, '', command)
  }
  for (const f of ['data/approvals.jsonl', 'results/runs.jsonl', 'waivers.jsonl']) {
    assert.equal(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(repo, f), content: '{}' } }).stdout, '', f)
  }
})

test('I2: in an opted-in repo Edit judges the real path: same-named project files pass, links into .sdlc do not', () => {
  sdlc(repo, ['new', 'tiny', '--type', 'chore', '--tier', 'S'])
  const edit = (f: string) => decision(hook(repo, 'pre-edit', { tool_input: { file_path: path.join(repo, f), content: '{}' } }))
  for (const f of ['data/approvals.jsonl', 'results/runs.jsonl', 'src/.gate', 'lib/changes/x/runs.jsonl']) assert.equal(edit(f), undefined, f)
  for (const f of ['.sdlc/approvals.jsonl', '.sdlc/changes/tiny/runs.jsonl', '.sdlc/./waivers.jsonl']) assert.equal(edit(f), 'deny', f)
  fs.symlinkSync(path.join(repo, '.sdlc'), path.join(repo, 'sneaky'))
  assert.equal(edit('sneaky/approvals.jsonl'), 'deny', 'symlinked directory into .sdlc')
  write(repo, '.sdlc/waivers.jsonl', '')
  fs.symlinkSync(path.join(repo, '.sdlc/waivers.jsonl'), path.join(repo, 'w.jsonl'))
  assert.equal(edit('w.jsonl'), 'deny', 'symlink to a waivers file')
  fs.linkSync(path.join(repo, '.sdlc/waivers.jsonl'), path.join(repo, 'hard.txt'))
  assert.equal(edit('hard.txt'), 'deny', 'hard link to a waivers file')
})

test('I2: in an opted-in repo Bash stays conservative: cd-then-relative and links into .sdlc are denied', () => {
  sdlc(repo, ['init'])
  const as = (command: string) => decision(hook(repo, 'pre-bash', { tool_input: { command } }))
  for (const c of ['cd .sdlc && echo x >> approvals.jsonl', 'cd .sdlc/changes/a && echo {} >> runs.jsonl', 'echo x >> .sdlc//approvals.jsonl',
    'ln -s .sdlc/approvals.jsonl a.txt', 'ln -s "$PWD/.sdlc" s', 'cp -s .sdlc/waivers.jsonl w', 'link .sdlc/waivers.jsonl w', 'python train.py > results/runs.jsonl'])
    assert.equal(as(c), 'deny', c)
  for (const c of ['ls -la .sdlc', 'cp src/a.js src/b.js', 'ln -s ../lib lib2', 'cat .sdlc/approvals.jsonl']) assert.equal(as(c), undefined, c)
})
