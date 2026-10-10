import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { checkRig } from '../shared/rigcontract.ts'
import { loadConfig } from './config.ts'
import { makeRepo } from '../shared/testkit.ts'

const copyFixture = (name: string): string => {
  const dir = makeRepo({ 'src/a/x.ts': 'export const x = 1\n' })
  fs.cpSync(path.join('contract', name, '.rig'), path.join(dir, '.rig'), { recursive: true })
  return dir
}

test('rig 0.6 fixture: supported, ignore globs are honored, intent.md readable', () => {
  const dir = copyFixture('rig-0.6')
  assert.deepEqual(checkRig(dir), { present: true, version: '0.6.0', supported: true })
  assert.ok(loadConfig(dir).ignore.includes('src/gen/**'))
  assert.match(fs.readFileSync(path.join(dir, '.rig/changes/demo/intent.md'), 'utf8'), /^# /m)
})

test('no rig: supported; old rig: not supported', () => {
  assert.deepEqual(checkRig(makeRepo({})), { present: false, version: null, supported: true })
  const old = makeRepo({ '.rig/bin/VERSION': '0.5.2\n' })
  assert.equal(checkRig(old).supported, false)
  assert.equal(checkRig(makeRepo({ '.rig/sensors.json': '{}' })).supported, false)   // rig present, version unreadable
  // the wiki's own files under .rig/ do not make a repo a rig repo
  assert.deepEqual(checkRig(makeRepo({ '.rig/wiki/INDEX.md': '#', '.rig/wiki.json': '{}' })), { present: false, version: null, supported: true })
})

test('memory files alone do not count as rig', () => {
  const dir = makeRepo({ '.rig/memory/MEMORY.md': '# Memory\n', '.rig/memory.json': '{}' }, { git: false })
  assert.equal(checkRig(dir).present, false)
})
