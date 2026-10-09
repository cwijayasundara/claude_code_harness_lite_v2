import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { PLUGIN } from '../../integration/lib/sandbox.mjs'

const GATE = path.join(PLUGIN, 'templates/production-gate.sh')
const payload = (command, session = 's1') => JSON.stringify({ session_id: session, tool_input: { command } })

function gate(sb, command, env = {}) {
  return spawnSync('sh', [GATE], { input: payload(command), encoding: 'utf8', env: { ...sb.env, CLAUDE_PROJECT_DIR: sb.dir, ...env } })
}

export async function assertProductionGate(c, sb) {
  // The gate logs only when .sdlc exists; never rely on it.
  fs.mkdirSync(sb.file('.sdlc'), { recursive: true })
  fs.rmSync(sb.file('.sdlc/gates.jsonl'), { force: true })

  const blocked = gate(sb, 'npm run deploy -- --env production')
  await c.check('deploy gate: production without RELEASE_APPROVAL exits 2 with the route', () =>
    (blocked.status === 2 && /RELEASE_APPROVAL/.test(blocked.stderr)) || `exit ${blocked.status}: ${blocked.stderr.trim()}`)

  const allowed = gate(sb, 'npm run deploy -- --env production', { RELEASE_APPROVAL: 'CHG-1' })
  await c.check('deploy gate: production with RELEASE_APPROVAL exits 0', () => allowed.status === 0 || `exit ${allowed.status}`)

  const other = gate(sb, 'npm run deploy -- --env staging')
  await c.check('deploy gate: a staging deploy is not gated', () => other.status === 0 || `exit ${other.status}`)

  const plain = gate(sb, 'npm test')
  await c.check('deploy gate: an unrelated command is not gated', () => plain.status === 0 || `exit ${plain.status}`)

  await c.check('deploy gate: logs the block and the allow, and nothing else', () => {
    const rows = sb.read('.sdlc/gates.jsonl').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    const got = rows.map(r => r.decision).join(',')
    return got === 'block,allow' || `decisions: ${got}`
  })
  await c.check('deploy gate: never logs the command text', () => !/deploy|npm/.test(sb.read('.sdlc/gates.jsonl')) || 'command text found in gates.jsonl')
}

// RIG_ROLLBACK_COMMAND is a script the project owns; the rehearsal is that command running and succeeding.
export async function assertRollbackRehearsal(c, sb) {
  sb.write('scripts/rollback.sh', '#!/bin/sh\necho rolled-back > .rollback-ran\n')
  const r = sb.run('sh', ['-c', 'RIG_ROLLBACK_COMMAND="sh scripts/rollback.sh"; sh -c "$RIG_ROLLBACK_COMMAND"'])
  await c.check('rollback rehearsal: the rollback command runs and succeeds', () => (r.status === 0 && sb.exists('.rollback-ran')) || `exit ${r.status}`)
  sb.run('rm', ['-f', sb.file('.rollback-ran'), sb.file('scripts/rollback.sh')])
}

const cli = () => fs.readFileSync(path.join(PLUGIN, 'scripts/sdlc.ts'), 'utf8')

// One workflow template: it parses and defines jobs, and every sdlc.ts subcommand it calls exists in the CLI's command table.
export async function assertWorkflowText(c, name, text) {
  const known = cmd => new RegExp(`^\\s+'?${cmd}'?:`, 'm').test(cli())
  await c.check(`workflow ${name}: parses as YAML with jobs`, () => Object.keys(parse(text).jobs ?? {}).length > 0 || 'no jobs')
  const code = text.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
  const cmds = [...code.matchAll(/sdlc\.ts\s+([a-z][a-z-]*)/g)].map(m => m[1])
  await c.check(`workflow ${name}: every sdlc.ts command it calls exists`, () => {
    const missing = [...new Set(cmds)].filter(x => !known(x))
    return missing.length === 0 || `unknown: ${missing.join(', ')}`
  })
}

export async function assertWorkflows(c) {
  const dir = path.join(PLUGIN, 'templates')
  for (const f of fs.readdirSync(dir).filter(n => /^rig-.*\.yml$/.test(n))) await assertWorkflowText(c, f, fs.readFileSync(path.join(dir, f), 'utf8'))
}
