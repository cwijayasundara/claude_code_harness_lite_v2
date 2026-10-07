// `sdlc.ts preflight`: one complete readiness report for the repo, written to .sdlc/PREFLIGHT.md. Every check runs, each states the exact
// fix, nothing retries, and the questions only a person can answer are recorded verbatim (the unanswered ones become open items).
// Repo contents are data: manifests and config are read, never run; every repo-derived string is flattened before it reaches the report,
// and a suggested fix only names a value that passed a plain-charset check. The only file written is .sdlc/PREFLIGHT.md.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, SDLC, git, read, exists, now, out, fail, type Args } from './core.ts'
import { parseConfig, type SensorConfig } from './model.ts'
import { requirements, hostVersion, parseVersion, satisfies, realRunner, type Runner, type Tool } from './toolchain.ts'

export type Check = { id: string; status: 'pass' | 'warn' | 'fail' | 'skip'; line: string; fix?: string }

const ANSWER_KEYS = ['gates', 'valueRate', 'consumers']
const MAX_ANSWERS = 4096
const MAX_ANSWER = 500
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/
const SAFE = /^[\w.@~/:+-]+$/

// One table cell: no pipes, no line breaks, no control characters, bounded length.
const cell = (text: string): string => {
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\|/g, '/')
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat
}
// A URL with its credentials removed (https://user:token@host).
const redact = (url: string): string => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1')

// The person's answers from init: a small object of the known keys, each a one-line value. A string is an error message.
export function parseAnswers(raw: string): Record<string, string> | string {
  if (raw.length > MAX_ANSWERS) return `--answers is longer than ${MAX_ANSWERS} characters`
  let value: unknown
  try { value = JSON.parse(raw) } catch { return '--answers must be a JSON object' }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '--answers must be a JSON object'
  const answers: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (!ANSWER_KEYS.includes(k)) return `--answers: unknown key "${cell(k).slice(0, 40)}" (known: ${ANSWER_KEYS.join(', ')})`
    if (v === undefined || v === null) continue
    const text = typeof v === 'string' ? v : JSON.stringify(v)
    if (text.length > MAX_ANSWER) return `--answers: ${k} is longer than ${MAX_ANSWER} characters`
    if (CONTROL.test(text)) return `--answers: ${k} must be one line with no control characters`
    if (text.trim()) answers[k] = text
  }
  return answers
}

const onPath = (bin: string): boolean => (process.env.PATH ?? '').split(path.delimiter).some(d => { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true } catch { return false } })

// null: the command resolves. Otherwise the reason it would not run. The suite is never executed here.
export function resolveCommand(cmd: string, root: string): string | null {
  const w = cmd.trim().split(/\s+/)
  let i = 0
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i] ?? '')) i++
  const bin = w[i] ?? ''
  if (!bin) return 'empty command'
  if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn') {
    const sub = w[i + 1]
    const script = sub === 'run' || sub === 'run-script' ? w[i + 2] : sub
    if (!script || ['install', 'ci', 'i', 'add', 'audit'].includes(script)) return onPath(bin) ? null : `${bin} is not on PATH`
    let scripts: Record<string, unknown> = {}
    try { scripts = (JSON.parse(read(path.join(root, 'package.json')) || '{}') as { scripts?: Record<string, unknown> }).scripts ?? {} } catch { /* no readable package.json */ }
    return Object.hasOwn(scripts, script) && scripts[script] ? (onPath(bin) ? null : `${bin} is not on PATH`) : `package.json has no "${script}" script`
  }
  if (bin === 'make') {
    const target = w[i + 1]
    if (!target || target.startsWith('-')) return onPath('make') ? null : 'make is not on PATH'
    return new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'm').test(read(path.join(root, 'Makefile'))) ? null : `the Makefile has no "${target}" target`
  }
  if (bin.includes('/')) return exists(path.resolve(root, bin)) ? null : `${bin} not found`
  return onPath(bin) ? null : `${bin} is not on PATH`
}

// The HTTPS form of an SSH remote, only for a plain host and path (it is printed as a command to run).
export function httpsFallback(url: string): string | null {
  const m = /^(?:ssh:\/\/)?git@([\w.-]+)[:/]([\w.~/-]+?)(?:\.git)?$/.exec(url)
  return m ? `https://${m[1]}/${m[2]}.git` : null
}

export function checkRemote(url: string | null, reach: (u: string) => boolean): Check {
  if (!url) return { id: 'remote', status: 'skip', line: 'no origin remote: PRs stay local-only' }
  const shown = redact(url)
  if (url.startsWith('-')) return { id: 'remote', status: 'fail', line: `origin ${shown} is not a URL`, fix: 'git remote set-url origin <url>' }
  if (reach(url)) return { id: 'remote', status: 'pass', line: `origin reachable (${shown})` }
  const alt = httpsFallback(url)
  if (alt && reach(alt)) return { id: 'remote', status: 'pass', line: `origin reachable over HTTPS (the SSH URL failed): ${alt}`, fix: `git remote set-url origin ${alt} if you want it permanent` }
  return { id: 'remote', status: 'fail', line: `origin ${shown} is not reachable`, fix: 'check your network and credentials, then rerun preflight' }
}

// SSH in batch mode without losing the user's own ssh setup: an explicit GIT_SSH_COMMAND or GIT_SSH is left alone; a configured
// core.sshCommand is carried into the env var (which git prefers over it) with BatchMode appended.
export function sshEnv(env: NodeJS.ProcessEnv, coreSshCommand: string | null): NodeJS.ProcessEnv {
  if (env.GIT_SSH_COMMAND || env.GIT_SSH) return { ...env }
  return { ...env, GIT_SSH_COMMAND: `${coreSshCommand || 'ssh'} -o BatchMode=yes` }
}

// One bounded, prompt-free probe: no shell, `--` before the URL, SSH in batch mode, the ext transport off.
const reachReal = (u: string): boolean => spawnSync('git', ['-c', 'protocol.ext.allow=never', 'ls-remote', '--heads', '--', u], {
  cwd: ROOT, timeout: 10_000, stdio: 'ignore',
  env: { ...sshEnv(process.env, git(['config', 'core.sshCommand'])), GIT_TERMINAL_PROMPT: '0' },
}).status === 0

type Opts = { root: string; run: Runner; reach: (u: string) => boolean; answers: Record<string, string> }

function toolchain(o: Opts): Check {
  const reqs = requirements(o.root)
  if (!reqs.length) return { id: 'toolchain', status: 'skip', line: 'no build file declares a toolchain version' }
  const tools = [...new Set(reqs.map(r => r.tool))] as Tool[]
  const lines: string[] = []
  let status: Check['status'] = 'pass'
  let fix: string | undefined
  for (const tool of tools) {
    const [primary, ...others] = reqs.filter(r => r.tool === tool)
    const need = parseVersion(primary?.required ?? '', tool)
    if (!primary || !need) continue
    const want = SAFE.test(primary.required) || /^[<>=~^\d. ]+$/.test(primary.required) ? primary.required : `${need.major}.${need.minor}`
    const host = hostVersion(tool, o.run, o.root)
    if (!host) { status = 'fail'; lines.push(`${tool} is not installed (${primary.source} requires ${primary.required})`); fix = `install ${tool} ${want}`; continue }
    if (!satisfies(host, need, tool)) { status = 'fail'; lines.push(`${tool} ${host.major} is older than the ${primary.required} ${primary.source} requires`); fix = `install ${tool} ${want} (declared in ${primary.source})`; continue }
    lines.push(`${tool} ${host.major} satisfies ${primary.required} (${primary.source})`)
    for (const other of others) {
      const v = parseVersion(other.required, tool)
      if (v && v.major !== need.major) { if (status === 'pass') status = 'warn'; lines.push(`note: ${other.source} says ${tool} ${other.required}; ${primary.source} wins`) }
    }
  }
  return lines.length ? { id: 'toolchain', status, line: lines.join('; '), fix } : { id: 'toolchain', status: 'skip', line: 'no declared toolchain version could be read' }
}

function commands(o: Opts, config: SensorConfig, errors: string[]): Check {
  const declared: [string, string][] = [
    ...Object.entries(config.fast).map(([k, v]): [string, string] => [`fast.${k}`, v]),
    ...Object.entries(config.full).map(([k, v]): [string, string] => [`full.${k}`, v]),
    ...Object.entries(config.levels).map(([k, v]): [string, string] => [`levels.${k}`, v ?? '']),
    ...Object.entries(config.quality).map(([k, v]): [string, string] => [`quality.${k}`, v?.cmd ?? '']),
  ]
  if (errors.length) return { id: 'commands', status: 'fail', line: `.sdlc/sensors.json: ${errors.join('; ')}`, fix: 'fix .sdlc/sensors.json so it parses, then rerun preflight' }
  if (!declared.length) return { id: 'commands', status: 'warn', line: 'no commands declared in .sdlc/sensors.json', fix: 'run /rig:init and declare fast, full and levels' }
  const bad = declared.map(([k, c]) => [k, resolveCommand(c, o.root)] as const).filter((e): e is [string, string] => e[1] !== null)
  return bad.length
    ? { id: 'commands', status: 'fail', line: bad.map(([k, why]) => `${k}: ${why}`).join('; '), fix: 'fix the command in .sdlc/sensors.json or add what it needs' }
    : { id: 'commands', status: 'pass', line: `${declared.length} declared command(s) resolve` }
}

function baseCheck(): Check {
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const hasBase = ['origin/main', 'main', 'origin/master', 'master'].some(r => git(['rev-parse', '--verify', '--quiet', r]))
  const dirty = (git(['status', '--porcelain', '--', '.', ':(exclude).sdlc']) ?? '').split('\n').filter(Boolean).length
  const notes = [head === 'HEAD' ? 'HEAD is detached' : '', hasBase ? '' : 'no main or master branch to compare against', dirty ? `${dirty} uncommitted file(s) outside .sdlc/` : ''].filter(Boolean)
  return notes.length ? { id: 'base', status: 'warn', line: notes.join('; '), fix: 'ship and the quality ratchet compare against the trunk: commit or stash, and work on a branch' } : { id: 'base', status: 'pass', line: `on ${head}, trunk found, tree clean` }
}

// A consumer clone is present when it has a .git entry; nothing runs inside it (its git config is not ours to trust).
function consumers(o: Opts, config: SensorConfig): Check {
  if (!config.consumers.length) return { id: 'consumers', status: 'skip', line: 'no consumer repos declared' }
  const missing = config.consumers.filter(c => !exists(path.join(path.resolve(o.root, c.path), '.git')))
  const fixFor = (c: SensorConfig['consumers'][number]): string => (c.repo && /^[\w.-]+\/[\w.-]+$/.test(c.repo) && SAFE.test(c.path) && !c.path.startsWith('-')
    ? `git clone https://github.com/${c.repo}.git ${c.path}` : `clone the ${c.name} repo to the path declared in .sdlc/sensors.json`)
  return missing.length
    ? { id: 'consumers', status: 'fail', line: missing.map(c => `${c.name} is not a git repo at ${c.path}`).join('; '), fix: missing.map(fixFor).join(' ; ') }
    : { id: 'consumers', status: 'pass', line: `${config.consumers.length} consumer repo(s) present` }
}

function protection(o: Opts): Check {
  let deny: unknown = []
  try { deny = (JSON.parse(read(path.join(o.root, '.claude', 'settings.json')) || '{}') as { permissions?: { deny?: unknown } }).permissions?.deny ?? [] } catch { /* unreadable */ }
  const wanted = ['Edit(/.sdlc/approvals.jsonl)', 'Edit(/.sdlc/PREFLIGHT.md)']
  return Array.isArray(deny) && wanted.every(r => deny.includes(r))
    ? { id: 'protection', status: 'pass', line: 'evidence deny rules are in .claude/settings.json' }
    : { id: 'protection', status: 'fail', line: 'the evidence deny rules are missing from .claude/settings.json', fix: 'run `sdlc.ts init --full` (it merges templates/settings.json)' }
}

const STACKS: [string, string][] = [['package.json', 'node'], ['go.mod', 'go'], ['pom.xml', 'java-maven'], ['pyproject.toml', 'python'], ['requirements.txt', 'python']]

export function runPreflight(o: Opts): { checks: Check[]; open: string[]; result: 'pass' | 'fail' } {
  let parsed: ReturnType<typeof parseConfig> | null = null
  const cfg = (): ReturnType<typeof parseConfig> => (parsed ??= parseConfig(read(path.join(o.root, '.sdlc', 'sensors.json'))))
  const steps: [string, () => Check][] = [
    ['stack', () => { const s = STACKS.filter(([f]) => exists(path.join(o.root, f))).map(([, n]) => n); return s.length ? { id: 'stack', status: 'pass', line: [...new Set(s)].join(', ') } : { id: 'stack', status: 'skip', line: 'no known manifest found' } }],
    ['toolchain', () => toolchain(o)], ['commands', () => commands(o, cfg().config, cfg().errors)], ['base', baseCheck],
    ['remote', () => checkRemote(git(['remote', 'get-url', 'origin']), o.reach)], ['consumers', () => consumers(o, cfg().config)], ['protection', () => protection(o)],
  ]
  const checks = steps.map(([id, fn]): Check => {
    let c: Check
    try { c = fn() } catch (e) { c = { id, status: 'fail', line: `check crashed: ${(e as Error).message}` } }
    return { ...c, line: cell(c.line), ...(c.fix ? { fix: cell(c.fix) } : {}) }
  })
  const open = ANSWER_KEYS.filter(k => o.answers[k] === undefined).map(k => `open item: ${k} was not answered`)
  return { checks, open, result: checks.some(c => c.status === 'fail') ? 'fail' : 'pass' }
}

// Replace, never follow: a symlink (or anything but a regular file) at the report path is removed first, and the write is exclusive.
function writeReport(text: string): void {
  fs.mkdirSync(SDLC, { recursive: true })
  const sdlcReal = fs.realpathSync(SDLC)
  const rootReal = fs.realpathSync(ROOT)
  if (fs.lstatSync(SDLC).isSymbolicLink() || path.relative(rootReal, sdlcReal).startsWith('..')) fail('.sdlc is a link out of this repo; not writing PREFLIGHT.md there')
  const file = path.join(SDLC, 'PREFLIGHT.md')
  try { fs.unlinkSync(file) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') fail(`cannot replace .sdlc/PREFLIGHT.md: ${(e as Error).message}`) }
  fs.writeFileSync(file, text, { flag: 'wx' })
}

export function cmdPreflight(args: Args): void {
  let answers: Record<string, string> = {}
  if (args.opt.answers !== undefined) {
    const parsed = typeof args.opt.answers === 'string' ? parseAnswers(args.opt.answers) : '--answers needs a JSON object'
    if (typeof parsed === 'string') fail(parsed)
    answers = parsed
  }
  const r = runPreflight({ root: ROOT, run: realRunner, reach: reachReal, answers })
  const rows = r.checks.map(c => `| ${c.id} | ${c.status} | ${c.line}${c.fix ? ` Fix: ${c.fix}` : ''} |`)
  const fixes = r.checks.filter(c => c.status === 'fail' && c.fix).map(c => `- ${c.id}: ${c.fix}`)
  const text = [
    '---', 'generated: sdlc', `at: ${now()}`, `head: ${git(['rev-parse', '--short', 'HEAD']) ?? 'none'}`, `result: ${r.result}`, '---',
    '# Preflight', '', '| check | status | detail |', '|---|---|---|', ...rows, '',
    ...(fixes.length ? ['## Fix these first', ...fixes, ''] : []),
    '## Answers', ...ANSWER_KEYS.filter(k => answers[k] !== undefined).map(k => `- ${k}: ${answers[k]}`), '',
    ...(r.open.length ? ['## Open items', ...r.open.map(o => `- ${o}`), ''] : []),
  ].join('\n')
  writeReport(text)
  out(text)
  process.exitCode = r.result === 'fail' ? 1 : 0
}
