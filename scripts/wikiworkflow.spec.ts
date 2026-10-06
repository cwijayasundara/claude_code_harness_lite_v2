import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')
const yml = read('templates/rig-wiki.yml')

/** The text of every `run:` block (inline or `|`/`>` block scalar) in the workflow. */
const runBlocks = (text: string): string[] => {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i] ?? '')
    if (!m) continue
    const indent = (m[1] ?? '').length
    const body: string[] = [m[2] ?? '']
    while (i + 1 < lines.length) {
      const next = lines[i + 1] ?? ''
      if (next.trim() !== '' && next.length - next.trimStart().length <= indent) break
      body.push(next)
      i++
    }
    out.push(body.join('\n'))
  }
  return out
}

/** The text of one job (from `  name:` to the next two-space key). */
const job = (text: string, name: string): string => {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l === `  ${name}:`)
  if (start < 0) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^ {0,2}\S/.test(lines[i] ?? '')) { end = i; break }
  return lines.slice(start, end).join('\n')
}

/** A job's steps: every list item at the steps indentation is its own step, named or not. */
const steps = (jobText: string): string[] => jobText.split(/\n(?= {6}- )/).slice(1)
const stepWith = (jobText: string, needle: RegExp): string => steps(jobText).find(b => needle.test(b)) ?? ''
const byId = (jobText: string, id: string): string => stepWith(jobText, new RegExp(`^ {8}id: ${id}$`, 'm'))

const ALLOWED_PUSH =
  /^\s*git -c "http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic \$hdr" push --force origin rig\/wiki-refresh\s*$/

/** Every non-comment line that runs `git ... push` (continuation lines joined) and is not exactly the one allowed command. */
const pushViolations = (text: string): string[] =>
  text.replace(/\\\n\s*/g, ' ').split('\n').filter(l => !/^\s*#/.test(l) && /\bgit\b[^\n]*\bpush\b/.test(l) && !ALLOWED_PUSH.test(l))

/** Structural rules that keep the write token away from the model. */
const privilegeProblems = (text: string): string[] => {
  const p: string[] = []
  const gen = job(text, 'generate')
  const pub = job(text, 'publish')
  if (!gen || !pub) return ['both jobs must exist']
  if (!/^ {4}permissions:\n {6}contents: read\s*$/m.test(gen.split('\n    steps:')[0] ?? '') || /write/.test(gen.split('\n    steps:')[0] ?? '')) p.push('generate must have contents: read only')
  if (/\bwrite\b/.test(text.slice(0, text.indexOf('\njobs:')).split('\n').filter(l => !/^\s*#/.test(l)).join('\n'))) p.push('no workflow-level write permission')
  if ((text.match(/contents: write/g) ?? []).length !== 1 || !/contents: write/.test(pub)) p.push('contents: write only in publish')
  if ((text.match(/claude-code-action/g) ?? []).length !== 1 || !gen.includes('claude-code-action')) p.push('the model action only in generate')
  if (/claude-code-action|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/.test(pub)) p.push('publish holds no model action or model secret')
  const withHeader = steps(pub).filter(b => b.includes('extraheader'))
  if (text.split('extraheader').length - 1 !== withHeader.length || withHeader.length !== 1 || !/\bpush\b/.test(withHeader[0] ?? '')) p.push('extraheader only in the publish push step')
  for (const j of [gen, pub]) {
    const co = stepWith(j, /uses:\s*actions\/checkout/)
    if (!/persist-credentials:\s*false/.test(co)) p.push('every checkout sets persist-credentials: false')
  }
  const dis = /--disallowedTools\s+"([^"]*)"/.exec(gen)?.[1] ?? ''
  if (!dis.includes('Read(./.git/**)') || !dis.includes('Bash')) p.push('the model may not read .git or run Bash')
  const pubText = pub
  const check = pubText.indexOf('wiki build --check')
  const add = pubText.indexOf('git add')
  if (check < 0 || add < 0 || check > add) p.push('wiki build --check must run before git add')
  return p
}

/** Failure-handling rules, checked on the specific steps and jobs. */
const failureProblems = (text: string): string[] => {
  const p: string[] = []
  const gen = job(text, 'generate')
  const pub = job(text, 'publish')
  if (!/continue-on-error: true/.test(byId(gen, 'model'))) p.push('model step continues on error')
  if (!/continue-on-error: true/.test(byId(gen, 'stamp'))) p.push('stamp step continues on error')
  const rebuild = byId(gen, 'rebuild')
  if (!rebuild || /continue-on-error/.test(rebuild) || !/steps\.model\.outcome != 'skipped'/.test(rebuild)) p.push('rebuild is loud and runs after any model attempt')
  const build = byId(gen, 'build')
  if (!build || /continue-on-error/.test(build)) p.push('the first build fails the job loudly')
  const head = pub.split('\n    steps:')[0] ?? ''
  if (!/if: \$\{\{ !cancelled\(\) && needs\.generate\.result == 'success' \}\}/.test(head)) p.push('publish runs only after a successful generate')
  if (!/needs: generate/.test(head)) p.push('publish needs generate')
  if (!/if: github\.ref_name == github\.event\.repository\.default_branch/.test(gen.split('\n    steps:')[0] ?? '')) p.push('generate runs only on the default branch')
  return p
}

test('rig-wiki.yml: the model runs in a read-only job; the write token exists only in the publish job, where no model runs', () => {
  assert.deepEqual(privilegeProblems(yml), [])
  assert.deepEqual(pushViolations(yml), [], 'every push line is the one allowed command')
  assert.match(yml, /gh pr create/)
  assert.doesNotMatch(yml, /git[^\n]*push[^\n]*\b(main|master)\b/)
  assert.match(yml, /GH_TOKEN: \$\{\{ secrets\.RIG_WIKI_TOKEN \|\| github\.token \}\}/)
  assert.match(yml, /::add-mask::/)
  assert.match(yml, /sk-ant-\[A-Za-z0-9_-\]\{20,\}\|gh\[pousr\]/)
  assert.match(job(yml, 'publish'), /find [^\n]*-type l/)
  assert.match(job(yml, 'generate'), /find docs\/wiki -type l/)
  assert.match(yml, /gh pr view rig\/wiki-refresh/)
})

test('rig-wiki.yml: the zero-token step comes first and holds no secret', () => {
  const gen = job(yml, 'generate')
  const zero = byId(gen, 'build')
  assert.ok(zero.includes('wiki build') && !zero.includes('secrets.'), 'the regeneration step uses no secret')
  assert.ok(gen.indexOf('wiki build') < gen.indexOf('claude-code-action'))
  assert.match(yml, /pull-requests: write/)
})

test('rig-wiki.yml: failures are loud, never hidden, and the publish job runs only after a good generate', () => {
  assert.deepEqual(failureProblems(yml), [])
})

test('rig-wiki.yml: third-party actions are pinned to a commit, and the model gets no shell or network and may edit only docs/wiki', () => {
  for (const m of yml.matchAll(/uses:\s*(\S+)/g)) {
    const use = m[1] ?? ''
    if (!use.startsWith('actions/')) assert.match(use, /@[0-9a-f]{40}$/, `${use} must be pinned to a commit SHA`)
  }
  const allowed = /--allowedTools\s+"([^"]*)"/.exec(yml)?.[1] ?? ''
  assert.ok(allowed.includes('Edit(./docs/wiki/**)') && !/Bash|WebFetch|WebSearch/.test(allowed))
  assert.match(yml, /--disallowedTools\s+"[^"]*Bash/)
})

test('rig-wiki.yml: repository text never reaches a shell by interpolation, and no privileged trigger or secret leaks into a run block', () => {
  const blocks = runBlocks(yml)
  assert.ok(blocks.length >= 8, 'the run blocks were found')
  for (const b of blocks) {
    assert.doesNotMatch(b, /\$\{\{\s*(?:steps|needs)\./, 'a run block interpolates a step or job output')
    assert.doesNotMatch(b, /\$\{\{\s*github\.event/, 'a run block interpolates an event field')
    assert.doesNotMatch(b, /\$\{\{\s*(?:inputs|env)\./, 'a run block interpolates an input')
    assert.doesNotMatch(b, /secrets\./, 'a run block references a secret')
  }
  assert.doesNotMatch(yml, /^\s*pull_request_target\s*:/m)
  assert.doesNotMatch(yml, /^\s*workflow_run\s*:/m)
})

test('mutations: the lint catches each way the design could be undone', () => {
  const mutate = (from: string | RegExp, to: string): string => {
    const out = yml.replace(from, to)
    assert.ok(out !== yml, `mutation did not apply: ${String(from)}`)
    return out
  }
  const pushLine = "          git -c \"http.https://github.com/.extraheader=AUTHORIZATION: basic $hdr\" push --force origin rig/wiki-refresh"
  assert.ok(yml.includes(pushLine))
  for (const bad of [
    'git push origin HEAD:main',
    'git push --force origin +HEAD:main',
    'git push --force origin HEAD:"$BASE"',
    'git push --force origin rig/wiki-refresh main',
    'git -c x=y \\\n            push --force origin HEAD:main',
  ]) {
    assert.equal(pushViolations(mutate(pushLine, `${pushLine}\n          ${bad}`)).length, 1, bad)
  }
  assert.equal(pushViolations(mutate(pushLine, 'git -c x=y \\\n            push --force origin HEAD:main')).length, 1)
  // privilege
  assert.ok(privilegeProblems(mutate(/(  generate:[\s\S]*?permissions:\n {6}contents: )read/, '$1write')).length > 0)
  assert.ok(privilegeProblems(mutate('      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n          persist-credentials: false', '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0')).length > 0)
  assert.ok(privilegeProblems(mutate(',Read(./.git/**)', '')).length > 0)
  assert.ok(privilegeProblems(mutate(/(  publish:[\s\S]*?steps:\n)/, '$1      - run: echo ${ANTHROPIC_API_KEY} extraheader\n')).length > 0)
  assert.ok(privilegeProblems(mutate(/(  publish:[\s\S]*?steps:\n)/, '$1      - uses: anthropics/claude-code-action@ed670b4cf9de2a5a570d130d2f6197b9e543cd64\n')).length > 0)
  assert.ok(privilegeProblems(mutate(/wiki build --check/g, 'wiki build')).length > 0, 'the --check gate is required')
  assert.ok(privilegeProblems(mutate(/ {6}- name: Open or update the refresh PR/, "      - run: echo extraheader\n      - name: Open or update the refresh PR")).length > 0, 'an unnamed step is its own step')
  // failure handling
  assert.ok(failureProblems(mutate(/(id: model\n)( {8}continue-on-error: true\n)/, '$1')).length > 0)
  assert.ok(failureProblems(mutate(/(id: stamp\n[^\n]*\n)( {8}continue-on-error: true\n)/, '$1')).length > 0)
  assert.ok(failureProblems(mutate(/(id: rebuild\n)/, '$1        continue-on-error: true\n')).length > 0)
  assert.ok(failureProblems(mutate("needs.generate.result == 'success'", "needs.generate.result != 'x'")).length > 0)
  assert.ok(failureProblems(mutate('!cancelled() && needs', 'needs')).length > 0)
  assert.ok(failureProblems(mutate(/(id: build\n)/, '$1        continue-on-error: true\n')).length > 0)
})

test('the wiki agent writes prose only, and the skills point at build and the new flows', () => {
  const agent = read('agents/wiki.md')
  assert.match(agent, /In plain words/)
  assert.match(agent, /Walk-through/)
  assert.match(agent, /rig:gen/)
  assert.match(agent, /never (?:edit|touch)[^\n]*(?:generated|rig:gen)/i)
  assert.match(agent, /untrusted data/i)
  const skill = read('skills/wiki/SKILL.md')
  assert.match(skill, /wiki build/)
  assert.match(skill, /prose/)
  assert.match(read('skills/init/SKILL.md'), /rig-wiki\.yml/)
})
