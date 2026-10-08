// Role by tier routing: the table, floors, the retry step and overrides (spec 2026-10-08 §4, §5).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { route, routes, parseRouting, roleOf, ROLES, TABLE, type Role, type Route } from './routing.ts'

const r = (role: Role, tier: 'S' | 'M' | 'L', type = 'feature' as const, round = 0) => route(role, type, tier, round).route

test('every role and tier returns the spec table', () => {
  const want: Record<Role, [Route, Route, Route]> = {
    scout: [{ model: 'haiku', effort: 'low' }, { model: 'haiku', effort: 'low' }, { model: 'haiku', effort: 'low' }],
    researcher: [{ model: 'haiku', effort: 'low' }, { model: 'haiku', effort: 'low' }, { model: 'haiku', effort: 'low' }],
    architect: ['main', 'main', { model: 'opus', effort: 'high' }],
    implementer: [{ model: 'haiku', effort: 'medium' }, { model: 'sonnet', effort: 'medium' }, { model: 'sonnet', effort: 'high' }],
    'slice-review': [{ model: 'sonnet', effort: 'high' }, { model: 'sonnet', effort: 'high' }, { model: 'sonnet', effort: 'high' }],
    reviewer: [{ model: 'sonnet', effort: 'medium' }, { model: 'sonnet', effort: 'high' }, { model: 'opus', effort: 'high' }],
    referee: [{ model: 'sonnet', effort: 'medium' }, { model: 'sonnet', effort: 'medium' }, { model: 'sonnet', effort: 'high' }],
    triage: [{ model: 'haiku', effort: 'low' }, { model: 'haiku', effort: 'low' }, { model: 'haiku', effort: 'low' }],
  }
  for (const role of ROLES) assert.deepEqual([r(role, 'S'), r(role, 'M'), r(role, 'L')], want[role], role)
})

test('greenfield uses the L column at every tier', () => {
  for (const role of ROLES) assert.deepEqual(route(role, 'greenfield', 'S').route, TABLE[role].L, role)
})

test('a retry raises the implementer effort first, then the model, and stops at opus high', () => {
  assert.deepEqual(r('implementer', 'S', 'feature', 1), { model: 'haiku', effort: 'high' })
  assert.deepEqual(r('implementer', 'S', 'feature', 2), { model: 'sonnet', effort: 'medium' })
  assert.deepEqual(r('implementer', 'M', 'feature', 1), { model: 'sonnet', effort: 'high' })
  assert.deepEqual(r('implementer', 'L', 'feature', 1), { model: 'opus', effort: 'medium' })
  assert.deepEqual(r('implementer', 'L', 'feature', 9), { model: 'opus', effort: 'high' })
  assert.deepEqual(r('reviewer', 'S', 'feature', 2), TABLE.reviewer.S, 'only the implementer retries upward')
})

test('an override above the floor is honoured; below it is clamped with a warning naming the role', () => {
  const up = route('implementer', 'feature', 'S', 0, { implementer: { S: { model: 'sonnet' } } })
  assert.deepEqual(up.route, { model: 'sonnet', effort: 'medium' })
  assert.equal(up.warning, undefined)
  const down = route('reviewer', 'feature', 'S', 0, { reviewer: { S: { model: 'haiku', effort: 'low' } } })
  assert.deepEqual(down.route, { model: 'sonnet', effort: 'low' })
  assert.match(down.warning ?? '', /reviewer.*floor.*sonnet/)
  const l = route('implementer', 'feature', 'L', 0, { implementer: { L: { model: 'haiku' } } })
  assert.equal((l.route as { model: string }).model, 'sonnet')
})

test('routes collects every role and every warning', () => {
  const { routes: all, warnings } = routes('feature', 'M', 0, { reviewer: { M: { model: 'haiku' } }, referee: { M: { model: 'opus' } } })
  assert.deepEqual(Object.keys(all).sort(), [...ROLES].sort())
  assert.equal((all.referee as { model: string }).model, 'opus')
  assert.equal(warnings.length, 1)
})

test('parseRouting accepts model and model:effort, and rejects everything else', () => {
  const errors: string[] = []
  assert.deepEqual(parseRouting({ implementer: { S: 'sonnet:high' }, reviewer: { M: 'opus' } }, errors), {
    implementer: { S: { model: 'sonnet', effort: 'high' } },
    reviewer: { M: { model: 'opus' } },
  })
  assert.deepEqual(errors, [])
  const bad: string[] = []
  parseRouting({ nobody: { S: 'haiku' }, implementer: { X: 'haiku', M: 'gpt', L: 'sonnet:max' }, architect: { S: 'opus' } }, bad)
  assert.equal(bad.length, 5, bad.join('\n'))
  const notObject: string[] = []
  parseRouting('haiku', notObject)
  assert.match(notObject[0] ?? '', /routing must be/)
  const pinned: string[] = []
  parseRouting({ scout: { S: 'sonnet' }, triage: { L: 'opus' }, researcher: { M: 'sonnet' } }, pinned)
  assert.equal(pinned.length, 3)
  assert.match(pinned[2] ?? '', /researcher.*pinned in agents\/researcher\.md/)
  assert.match(pinned[0] ?? '', /scout.*pinned in agents\/scout\.md/)
})

test('roleOf maps agent type and stage to a role; the reviewer splits by stage', () => {
  assert.equal(roleOf('rig:scout', 'plan'), 'scout')
  assert.equal(roleOf('rig-implementer', 'build'), 'implementer')
  assert.equal(roleOf('implementer', 'test'), 'implementer')
  assert.equal(roleOf('rig:reviewer', 'build'), 'slice-review')
  assert.equal(roleOf('rig:reviewer', 'pr-review'), 'reviewer')
  assert.equal(roleOf('general-purpose', 'build'), 'other')
  assert.equal(roleOf(undefined, null), 'other')
})
