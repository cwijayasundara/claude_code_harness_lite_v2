// The init skill tells a model how to write .sdlc/sensors.json; what it shows must be what the harness's own parser accepts.
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

test('init skill: rig-util is opt-in, per project, and skipped under --defaults', () => {
  assert.match(skill, /Optional add-on: rig-util/)
  assert.match(skill, /Never run `claude plugin install` and never write user settings/)
  assert.match(skill, /Skip:[^\n]*rig-util add-on/)
})

test('init skill: enabling rig-util seeds memory and the wiki rather than only registering the plugin', () => {
  assert.match(skill, /memory\.ts\b[^\n]*|\$M seed --placeholders/)
  assert.match(skill, /\$W index/)
  assert.match(skill, /\$W apply/)
  assert.match(skill, /Wiki, brownfield/)
  assert.match(skill, /\*\*Greenfield:\*\* run only `\$W index`/)
  assert.match(skill, /\.sdlc\/wiki\/` and `\.sdlc\/memory\/`/)
})
