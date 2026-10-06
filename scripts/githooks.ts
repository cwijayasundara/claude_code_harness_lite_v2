// Git hooks: the same checker as Stop, ship and CI, run at `git commit` and `git push`, so any editor, agent or person is judged.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SDLC, git, exists, out, fail, type Args } from './core.ts'

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
  writeHookScripts()
  const { state, path: current } = hooksState()
  if (state === 'other' && !force) {
    return { ok: false, message: `core.hooksPath is already ${current}, so it was left alone. Call rig from your existing hooks instead:\n  sh .sdlc/githooks/pre-commit\n  sh .sdlc/githooks/pre-push "$@"\nor re-run with --force to replace it.` }
  }
  git(['config', '--local', 'core.hooksPath', HOOKS_DIR])
  return { ok: true, message: `git hooks installed (core.hooksPath = ${HOOKS_DIR}): commit and push now run the rig checks` }
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
