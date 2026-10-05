// Test helpers shared by the spec files. Never vendored into projects.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'

export const SCRIPT = path.resolve(import.meta.dirname, 'sdlc.ts')

export function gitIn(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

export function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-test-'))
  gitIn(repo, 'init', '-q', '-b', 'main')
  gitIn(repo, 'config', 'user.email', 't@example.com')
  gitIn(repo, 'config', 'user.name', 'Tester')
  write(repo, 'README.md', 'hi\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-qm', 'init')
  return repo
}

export function write(repo: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), text)
}

// The runner marks its children as nested test runs; a consumer repo's own `node --test` must really run.
// The runner's own GitHub Actions context must not leak into the tests (a real GITHUB_EVENT_PATH changes what `check --at ci` does).
const { NODE_TEST_CONTEXT: _nested, GITHUB_EVENT_PATH: _event, GITHUB_STEP_SUMMARY: _summary, ...CLEAN_ENV } = process.env

export function sdlc(repo: string, args: string[], { input, env = {} }: { input?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], {
    cwd: repo, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: repo, SDLC_HUMAN: '', ...env },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

export const hook = (repo: string, name: string, payload: unknown) => sdlc(repo, ['hook', name], { input: JSON.stringify(payload) })

// The tier and type `new` recorded, kept when a helper rewrites ratchet.json.
function recorded(repo: string, slug: string): { tier?: string; type?: string } {
  try { const r = JSON.parse(fs.readFileSync(path.join(repo, `.sdlc/changes/${slug}/ratchet.json`), 'utf8')); return { tier: r.tier, type: r.type } } catch { return {} }
}

export function verified(repo: string, slug: string): void {
  sdlc(repo, ['run', '--slug', slug, '--', 'node -e "process.exit(0)"'])
  sdlc(repo, ['verify-report', slug])
}

// A change whose build and sensors nodes are done, so the graph reaches pr (the ratchet.json shape is Task 3's).
export function ratcheted(repo: string, slug: string): void {
  const node = { rounds: 0, hashes: [], status: 'done' }
  write(repo, `.sdlc/changes/${slug}/ratchet.json`, JSON.stringify({ ...recorded(repo, slug), nodes: { build: node, sensors: node }, slices: {}, baseline: {} }))
}

// A v0.4 change whose build node is done (every slice reviewed) and nothing later.
export function buildDone(repo: string, slug: string): void {
  write(repo, `.sdlc/changes/${slug}/ratchet.json`, JSON.stringify({ version: 4, ...recorded(repo, slug), nodes: { build: { rounds: 0, hashes: [], status: 'done' } }, slices: {}, baseline: {} }))
}
