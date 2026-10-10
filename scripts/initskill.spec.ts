// The init skill tells a model how to write .rig/sensors.json; what it shows must be what the harness's own parser accepts.
// A live run wrote `fast`/`full` as strings (as the skill said), and the ship gate then refused every change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseConfig } from './model.ts'

const skill = fs.readFileSync(path.resolve(import.meta.dirname, '../skills/init/SKILL.md'), 'utf8')

test('init skill: the sensors.json shape it shows for fast and full is accepted by the parser', () => {
  const shown = /`(\{"fast":[^`]*)`/.exec(skill)?.[1]
  assert.ok(shown, 'the skill must show a literal {"fast": {...}, "full": {...}} shape in inline code')
  const example = JSON.parse(shown.replace(/<[^>]+>/g, 'npm test'))
  const { errors } = parseConfig(JSON.stringify(example))
  assert.deepEqual(errors, [])
  assert.equal(typeof example.fast, 'object')
  assert.equal(typeof example.full, 'object')
})

test('init skill: never says fast/full are plain command strings', () => {
  assert.doesNotMatch(skill, /`fast`\/`full` command strings/)
})

test('init skill: a Node scaffold uses `node --test` with no directory argument (Node 24 treats `test/` as a module path)', () => {
  assert.match(skill, /`node --test`[^.]*no directory argument/)
  assert.doesNotMatch(skill, /node --test test\//)
})

test('init skill: rig-brain is opt-in, per project, and skipped under --defaults', () => {
  assert.match(skill, /Optional add-on: rig-brain/)
  assert.match(skill, /never run `claude plugin install` or `claude plugin marketplace add` for it and never write user settings/)
  assert.match(skill, /marketplace add <repo-root> --scope project/)
  assert.doesNotMatch(skill, /marketplace add <repo-root>`/)
  assert.match(skill, /Skip:[^\n]*rig-brain add-on/)
})

test('init skill: enabling rig-brain seeds memory and the wiki rather than only registering the plugin', () => {
  assert.match(skill, /memory\.ts\b[^\n]*|\$M seed --placeholders/)
  assert.match(skill, /\$W index/)
  assert.match(skill, /\$W apply/)
  assert.match(skill, /Wiki, brownfield/)
  assert.match(skill, /\*\*Greenfield:\*\* run only `\$W index`/)
  assert.match(skill, /\.rig\/wiki\/` and `\.rig\/memory\/`/)
})

test('init skill: writes rig docs into README.md between markers, brownfield in place and greenfield new', () => {
  const tpl = fs.readFileSync(path.resolve(import.meta.dirname, '../templates/readme-rig.md'), 'utf8')
  assert.match(skill, /templates\/readme-rig\.md/)
  assert.match(skill, /\*\*Brownfield:\*\* keep the existing `README\.md`/)
  assert.match(skill, /\*\*Greenfield:\*\* create `README\.md`/)
  assert.match(tpl, /^<!-- rig:begin/)
  assert.match(tpl.trimEnd(), /<!-- rig:end -->$/)
  assert.match(tpl, /### Architecture/)
  assert.match(tpl, /### User guide/)
  assert.match(tpl, /\{\{P\}\}/)
  assert.match(tpl, /\{\{BRAIN\}\}/)
})

test('init skill: warns when the main model is Opus, without blocking', () => {
  assert.match(skill, /\*\*Model check:\*\*[^\n]*Opus/)
  assert.match(skill, /Never stop on it/)
})
