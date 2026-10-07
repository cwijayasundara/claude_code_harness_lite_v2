// A throwaway repo for one lane: git on main, a local bare repo as origin, a stub gh on PATH, and settings that keep the
// person's own plugins out, so the run sees what a teammate's clone sees.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

export const PLUGIN = path.resolve(import.meta.dirname, '../../..')
export const FIXTURES = path.join(PLUGIN, 'tests/fixtures')

// The runner's own test or CI context must not leak into the sandbox's commands.
const { NODE_TEST_CONTEXT: _n, GITHUB_EVENT_PATH: _e, GITHUB_STEP_SUMMARY: _s, CLAUDE_PROJECT_DIR: _p, SDLC_HUMAN: _h, ...CLEAN_ENV } = process.env

// Every plugin installed for this person, so the sandbox can switch each off. Empty when the CLI is absent.
export function installedPlugins() {
  try {
    const list = JSON.parse(execFileSync('claude', ['plugin', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    return [...new Set(list.map(p => p.id).filter(Boolean))]
  } catch {
    return []
  }
}

export function createSandbox({ name, out }) {
  const root = path.join(out, name)
  fs.rmSync(root, { recursive: true, force: true })
  const dir = path.join(root, 'repo')
  const origin = path.join(root, 'origin.git')
  const bin = path.join(root, 'bin')
  const logs = path.join(root, 'logs')
  for (const d of [dir, bin, logs]) fs.mkdirSync(d, { recursive: true })
  fs.copyFileSync(path.join(import.meta.dirname, 'gh-stub.sh'), path.join(bin, 'gh'))
  fs.chmodSync(path.join(bin, 'gh'), 0o755)

  const env = { ...CLEAN_ENV, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RIG_GH_LOG: path.join(logs, 'gh.log') }
  const run = (cmd, args, opts = {}) =>
    spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts, env: { ...env, ...opts.env } })
  const git = (...args) => {
    const r = run('git', args)
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`)
    return r.stdout.trim()
  }

  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'operator@rig.test')
  git('config', 'user.name', 'rig operator')
  execFileSync('git', ['init', '-q', '--bare', origin])
  git('remote', 'add', 'origin', origin)

  const sb = {
    name, root, dir, origin, bin, logs, env, run, git,
    file: rel => path.join(dir, rel),
    read: rel => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), 'utf8') : ''),
    exists: rel => fs.existsSync(path.join(dir, rel)),
    write(rel, text) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), text)
    },
    // The repo's vendored checker once onboarded, the plugin's before: a teammate only ever has the vendored one.
    sdlc(args, { human = false } = {}) {
      const vendored = path.join(dir, '.sdlc/bin/sdlc.ts')
      const script = fs.existsSync(vendored) ? vendored : path.join(PLUGIN, 'scripts/sdlc.ts')
      const who = human ? { SDLC_HUMAN: '1' } : {}
      return run('node', ['--disable-warning=ExperimentalWarning', script, ...args], { env: { CLAUDE_PROJECT_DIR: dir, ...who } })
    },
    commitAll(message) {
      git('add', '-A')
      if (run('git', ['diff', '--cached', '--quiet']).status === 0) return false
      git('commit', '-q', '--no-verify', '-m', message)
      return true
    },
    // Project-local settings that switch off every installed plugin. Excluded through .git/info/exclude, so the repo
    // under test never sees the file and scope checks stay exact.
    isolate(plugins = installedPlugins()) {
      sb.write('.claude/settings.local.json', JSON.stringify({ enabledPlugins: Object.fromEntries(plugins.map(id => [id, false])) }, null, 2) + '\n')
      fs.appendFileSync(path.join(dir, '.git/info/exclude'), '.claude/settings.local.json\n')
    },
    copyFixture(name) {
      fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true })
    },
  }
  return sb
}
