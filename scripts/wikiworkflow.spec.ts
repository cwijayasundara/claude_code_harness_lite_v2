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


const ALLOWED_PUSH =
  /^\s*git -c "http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic \$\(printf 'x-access-token:%s' "\$GH_TOKEN" \| base64 \| tr -d '\\n'\)" push --force origin rig\/wiki-refresh\s*$/

/** Every non-comment line that runs `git ... push` and is not exactly the one allowed command. */
const pushViolations = (text: string): string[] =>
  text.split('\n').filter(l => !/^\s*#/.test(l) && /\bgit\b[^\n]*\bpush\b/.test(l) && !ALLOWED_PUSH.test(l))

/** The workflow's steps, each as its own text block. */
const steps = (text: string): string[] => text.split(/\n(?=\s+- (?:name|uses):)/)

const headerOk = (text: string): string[] => {
  const problems: string[] = []
  const checkout = steps(text).find(b => /uses:\s*actions\/checkout/.test(b)) ?? ''
  if (!/persist-credentials:\s*false/.test(checkout)) problems.push('checkout must set persist-credentials: false')
  const withHeader = steps(text).filter(b => b.includes('extraheader'))
  if (withHeader.length !== 1 || !/name: Open or update the refresh PR/.test(withHeader[0] ?? '')) problems.push('extraheader only in the PR step')
  return problems
}

test('rig-wiki.yml: the zero-token step comes first and holds no secret; a PR is opened, never a push to the default branch', () => {
  const zero = yml.slice(yml.indexOf('name: Regenerate'), yml.indexOf('name: Is a model secret'))
  assert.ok(zero.includes('wiki build') && !zero.includes('secrets.'), 'the regeneration step uses no secret')
  assert.ok(yml.indexOf('wiki build') < yml.indexOf('claude-code-action'))
  assert.match(yml, /gh pr create/)
  assert.doesNotMatch(yml, /git push[^\n]*\b(main|master)\b/)
  assert.match(yml, /\bpush --force origin rig\/wiki-refresh/)
  assert.match(yml, /pull-requests: write/)
  assert.deepEqual(pushViolations(yml), [], 'every push line is the one allowed command')
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
  assert.ok(blocks.length >= 4, 'the run blocks were found')
  for (const b of blocks) {
    assert.doesNotMatch(b, /\$\{\{\s*steps\./, 'a run block interpolates a step output')
    assert.doesNotMatch(b, /\$\{\{\s*github\.event/, 'a run block interpolates an event field')
    assert.doesNotMatch(b, /\$\{\{\s*(?:inputs|env)\./, 'a run block interpolates an input')
    assert.doesNotMatch(b, /secrets\./, 'a run block references a secret')
  }
  assert.doesNotMatch(yml, /^\s*pull_request_target\s*:/m)
  assert.doesNotMatch(yml, /^\s*workflow_run\s*:/m)
})

test('rig-wiki.yml: the model never sees the write token, and the push check rejects any other push', () => {
  assert.deepEqual(headerOk(yml), [])
  assert.match(yml, /find docs\/wiki -type l/)
  assert.match(yml, /GH_TOKEN: \$\{\{ secrets\.RIG_WIKI_TOKEN \|\| github\.token \}\}/)
  assert.match(yml, /sk-ant-\[A-Za-z0-9_-\]\{20,\}\|gh\[pousr\]/)
  assert.match(yml, /if: github\.ref_name == github\.event\.repository\.default_branch/)
  assert.match(yml, /id: model\b[\s\S]*continue-on-error: true/)
  assert.match(yml, /if: \$\{\{ !cancelled\(\)/)
  assert.match(yml, /gh pr view rig\/wiki-refresh/)
  const injected = (line: string) => yml.replace('      - name: Open or update the refresh PR', `      - run: ${line}\n      - name: Open or update the refresh PR`)
  for (const bad of ['git push origin HEAD:main', 'git push --force origin +HEAD:main', 'git push --force origin HEAD:"$BASE"', 'git push --force origin rig/wiki-refresh main']) {
    assert.equal(pushViolations(injected(bad)).length, 1, bad)
  }
  assert.ok(headerOk(yml.replace('persist-credentials: false', 'persist-credentials: true')).length > 0)
  assert.ok(headerOk(yml.replace('name: Regenerate', 'run: echo extraheader\n      - name: Regenerate')).length > 0)
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
