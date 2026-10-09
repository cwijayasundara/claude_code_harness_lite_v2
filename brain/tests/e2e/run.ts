import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const plugin = path.resolve('.')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigbrain-e2e-'))
fs.cpSync('tests/e2e/fixture', dir, { recursive: true })
const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' })
sh('git', ['init', '-q', '-b', 'main']); sh('git', ['add', '-A']); sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])

const r = sh('claude', ['-p', '/rig-brain:wiki-refresh', '--plugin-dir', plugin, '--permission-mode', 'acceptEdits'])
assert.equal(r.status, 0, r.stderr)
const mods = fs.readdirSync(path.join(dir, '.sdlc/wiki/modules'))
assert.ok(mods.length >= 3, `expected 3 module pages, got ${mods.join(',')}`)
for (const m of mods) assert.match(fs.readFileSync(path.join(dir, '.sdlc/wiki/modules', m), 'utf8'), /status: fresh/)
const index = fs.readFileSync(path.join(dir, '.sdlc/wiki/INDEX.md'), 'utf8')
for (const m of mods) assert.ok(index.includes(`**${m.replace(/\.md$/, '')}**`))
const st = spawnSync('node', ['--disable-warning=ExperimentalWarning', path.join(plugin, 'code_wiki/wiki.ts'), 'status'], { cwd: dir, encoding: 'utf8' })
assert.match(st.stdout, /stale: 0/)
console.log(`e2e ok: ${mods.length} pages in ${dir}`)
