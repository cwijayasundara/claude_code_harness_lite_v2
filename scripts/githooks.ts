// Git hooks: the same checker as Stop, ship and CI, run at `git commit` and `git push`, so any editor, agent or person is judged.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SDLC, git, exists, out, fail, type Args } from './core.ts'
import { loadConfig, runChecks } from './check.ts'
import { rangeDiff, showAt } from './diffs.ts'
import { activeSlug, createAdhoc } from './graph.ts'
import { runQuality } from './quality.ts'
import { tierFromDiff, isProtected } from './sensors.ts'
import { formatFindings, warnLines, isSource, type Finding } from './model.ts'

export const HOOKS_DIR = '.sdlc/githooks'
const NAMES = ['pre-commit', 'pre-push'] as const
const AT = { 'pre-commit': 'commit', 'pre-push': 'push' } as const

// A hook that cannot run warns and lets git go on: CI is the floor, and a broken hook must not wedge a repo.
const script = (name: (typeof NAMES)[number]): string => [
  '#!/bin/sh',
  '# rig: runs the same checker as Stop, ship and CI.',
  'cd "$(git rev-parse --show-toplevel)" || exit 0',
  `if ! command -v node >/dev/null 2>&1 || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'; then`,
  `  echo "rig: Node >= 22.18 not found, skipping ${name} (CI still checks)" >&2; exit 0`,
  'fi',
  `[ -f .sdlc/bin/sdlc.ts ] || { echo "rig: .sdlc/bin/sdlc.ts is missing, skipping ${name} (run vendor, then hooks install)" >&2; exit 0; }`,
  `exec node --disable-warning=ExperimentalWarning .sdlc/bin/sdlc.ts check --at ${AT[name]}`,
  '',
].join('\n')

export function writeHookScripts(written: string[] = []): void {
  fs.mkdirSync(path.join(ROOT, HOOKS_DIR), { recursive: true })
  for (const name of NAMES) {
    const file = path.join(ROOT, HOOKS_DIR, name)
    fs.writeFileSync(file, script(name))
    fs.chmodSync(file, 0o755)
    written.push(`${HOOKS_DIR}/${name}`)
  }
}

export type HooksState = 'installed' | 'missing' | 'other'
export function hooksState(): { state: HooksState; path: string } {
  const p = git(['config', '--local', '--get', 'core.hooksPath']) ?? ''
  return { state: p === HOOKS_DIR ? 'installed' : p === '' ? 'missing' : 'other', path: p }
}

export function installHooks(force = false): { ok: boolean; message: string } {
  if (!exists(path.join(SDLC, 'bin', 'sdlc.ts'))) return { ok: false, message: 'git hooks run the vendored checker: run `vendor` (or `vendor --standalone`) first so .sdlc/bin/sdlc.ts exists' }
  // An older vendored checker does not know `check --at commit` and would refuse every commit.
  if (!exists(path.join(SDLC, 'bin', 'githooks.ts'))) return { ok: false, message: '.sdlc/bin is older than the git hooks (no githooks.ts): re-run `vendor` to update it, then hooks install' }
  writeHookScripts()
  const { state, path: current } = hooksState()
  if (state === 'other' && !force) {
    return { ok: false, message: `core.hooksPath is already ${current}, so it was left alone. Call rig from your existing hooks instead:\n  sh .sdlc/githooks/pre-commit\n  sh .sdlc/githooks/pre-push "$@"\nor re-run with --force to replace it.` }
  }
  git(['config', '--local', 'core.hooksPath', HOOKS_DIR])
  return { ok: true, message: `git hooks installed (core.hooksPath = ${HOOKS_DIR}): commit and push now run the rig checks` }
}

// Session start wires committed hooks in a fresh clone (core.hooksPath is local git config, so a clone never has it).
export function sessionNote(): string {
  if (!exists(path.join(SDLC, 'bin', 'sdlc.ts')) || !exists(path.join(ROOT, HOOKS_DIR))) return ''
  const { state, path: current } = hooksState()
  if (state === 'installed') return ''
  if (state === 'other') return `Git hooks: core.hooksPath is ${current}, so the rig commit and push checks are not wired. Do not change it yourself: ask the person to run \`node .sdlc/bin/sdlc.ts hooks install --force\` if they want rig's hooks.`
  const r = installHooks()
  return r.ok ? `Git hooks: installed the rig pre-commit and pre-push checks (core.hooksPath = ${HOOKS_DIR}).` : `Git hooks: ${r.message}`
}

export function uninstallHooks(): string {
  if (hooksState().state !== 'installed') return 'rig git hooks are not installed; nothing changed'
  git(['config', '--local', '--unset', 'core.hooksPath'])
  return 'rig git hooks uninstalled (core.hooksPath unset); the scripts stay in .sdlc/githooks'
}

export function cmdHooks(args: Args): void {
  const sub = args.pos[0]
  if (sub === 'install') {
    const r = installHooks(Boolean(args.opt.force))
    if (!r.ok) fail(r.message)
    return out(r.message)
  }
  if (sub === 'uninstall') return out(uninstallHooks())
  if (sub === 'status') {
    const { state, path: p } = hooksState()
    return out(state === 'installed' ? `rig git hooks installed (${HOOKS_DIR})` : state === 'other' ? `rig git hooks not installed: core.hooksPath is ${p}` : 'rig git hooks not installed: run `sdlc.ts hooks install`')
  }
  out('usage: hooks install [--force] | uninstall | status')
}

const ZERO = /^0+$/
export type PushRef = { localRef: string; localSha: string; remoteRef: string; remoteSha: string }

// git feeds pre-push one line per ref: <local ref> <local sha> <remote ref> <remote sha>.
export function parsePushRefs(stdin: string): PushRef[] {
  return stdin.split('\n').filter(l => l.trim()).map(l => {
    const [localRef = '', localSha = '', remoteRef = '', remoteSha = ''] = l.trim().split(/\s+/)
    return { localRef, localSha, remoteRef, remoteSha }
  })
}

const TRUNKS = ['origin/main', 'main', 'origin/master', 'master']
// The base CI would use (the merge-base with the trunk, for the pushed commit, not HEAD), so merging or rebasing on
// the trunk never counts the trunk's own work. A push to the trunk itself judges what the remote lacks.
export function pushBase(r: PushRef): string | null {
  const trunk = TRUNKS.find(t => git(['rev-parse', '--verify', '--quiet', `${t}^{commit}`]))
  const mb = trunk ? git(['merge-base', r.localSha, trunk]) : null
  const tb = mb && mb !== r.localSha ? mb : null // already on the trunk: nothing of its own to compare
  const toTrunk = Boolean(trunk) && r.remoteRef === `refs/heads/${trunk?.replace('origin/', '')}`
  if (tb && !toTrunk) return tb
  const remote = ZERO.test(r.remoteSha) ? null : r.remoteSha
  return remote && git(['merge-base', '--is-ancestor', remote, r.localSha]) !== null ? remote : tb
}

const readStdin = (): string => { try { return fs.readFileSync(0, 'utf8') } catch { return '' } }
// Running out of budget is a warning at push: CI still runs the commands.
const soften = (f: Finding): Finding => (f.sensor === 'commands' && /budget ran out|timed out/.test(f.message) ? { ...f, severity: 'warn' } : f)

export function cmdCheckPush(_args: Args): void {
  const { config, rules, errors } = loadConfig()
  if (config.githooks.prePush === 'off') return out('sdlc check push: off (githooks.prePush)')
  const raw = readStdin()
  const refs = raw.trim()
    ? parsePushRefs(raw).filter(r => !ZERO.test(r.localSha) && r.remoteRef.startsWith('refs/heads/'))
    : [{ localRef: 'refs/heads/HEAD', localSha: git(['rev-parse', 'HEAD']) ?? '', remoteRef: 'refs/heads/HEAD', remoteSha: '0' }]
  if (!refs.length) return out('sdlc check push: nothing to judge (a delete or tag push)')
  const t0 = Date.now()
  const findings: Finding[] = errors.map(e => ({ sensor: 'config', severity: 'block', file: '.sdlc/sensors.json', message: e, fix: 'fix the file' }))
  const notes: string[] = []
  for (const r of refs) {
    const base = pushBase(r)
    if (!base || git(['cat-file', '-e', `${base}^{commit}`]) === null) { notes.push(`${r.remoteRef.replace('refs/heads/', '')}: no base to compare against, so CI judges it`); continue }
    const diffs = rangeDiff(base, r.localSha)
    if (!diffs.length) continue
    const active = activeSlug()
    const touched = diffs.some(d => isSource(d.file, config) && !isProtected(d.file))
    const slug = active ?? (touched ? createAdhoc(tierFromDiff(diffs, config)) : null)
    // A rig-managed change in flight is gated by /rig:pr; only ad-hoc work gets ship verdicts here.
    const shipSlugs = slug?.startsWith('adhoc-') ? [slug] : []
    const result = runChecks({
      point: 'ship', diffs, config, rules, slugs: shipSlugs, commands: 'full', budgetMs: config.githooks.budgetMs,
      before: f => showAt(base, f) ?? '', after: f => showAt(r.localSha, f) ?? '', base, ratchet: false,
    })
    findings.push(...result.findings.map(soften))
    if (slug && Object.values(config.quality).some(Boolean)) {
      if (Date.now() - t0 > config.githooks.budgetMs) notes.push('quality ratchet skipped: the push budget is used up')
      else findings.push(...runQuality(slug, base).blocks.filter(b => b.sensor.startsWith('quality.') || b.sensor === 'invariant'))
    }
  }
  if (!Object.values(config.quality).some(Boolean)) notes.push('quality ratchet skipped: no quality commands declared in .sdlc/sensors.json')
  const blocks = findings.filter(f => f.severity === 'block')
  out([formatFindings(findings) || 'sdlc check push: pass', ...warnLines(findings), ...notes].join('\n'))
  process.exitCode = blocks.length ? 1 : 0
}
