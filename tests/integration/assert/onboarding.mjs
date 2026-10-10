// What `/rig:init --defaults` must leave in a repo: a compact CLAUDE.md, a valid sensors.json with every test level, the
// standalone harness vendored at the plugin's version, the git hooks wired, a preflight report, all committed on main.
import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN } from '../lib/sandbox.mjs'
import { configOf } from '../lib/oracle.mjs'

const json = text => JSON.parse(text)
const pluginVersion = () => json(fs.readFileSync(path.join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8')).version
const names = (dir, ext = '') => fs.readdirSync(path.join(PLUGIN, dir)).filter(f => f.endsWith(ext)).map(f => f.slice(0, f.length - ext.length))

// lane: 'greenfield' | 'brownfield'. modules: directory names a brownfield CLAUDE.md map must name.
export async function assertOnboarding(c, sb, { lane, modules = [] }) {
  const claudeMd = sb.read('CLAUDE.md')
  await c.check('CLAUDE.md exists, at most 120 lines', () => (claudeMd !== '' && claudeMd.split('\n').length <= 120) || `${claudeMd.split('\n').length} lines`)
  // A standalone repo's skills are rig-*, so its CLAUDE.md must name /rig-start, not the plugin's /rig:start.
  await c.check('CLAUDE.md routes work to the standalone /rig-start', () =>
    /sdlc routes all work in this repo: start with \/rig-start;/.test(claudeMd) || 'routing line missing or names another start command')

  const cfg = configOf(sb.dir)
  await c.check('sensors.json parses with no config errors', () => cfg.errors.length === 0 || cfg.errors.join('; '))
  await c.check('fast and full commands run the tests', () => {
    const all = [...Object.values(cfg.config.fast ?? {}), ...Object.values(cfg.config.full ?? {})]
    return all.some(cmd => /test/.test(cmd)) || JSON.stringify({ fast: cfg.config.fast, full: cfg.config.full })
  })
  await c.check('gates are the harness defaults', () =>
    JSON.stringify(cfg.config.gates) === JSON.stringify(cfg.defaults.gates) || JSON.stringify(cfg.config.gates))
  await c.check('every test level a change can require is declared', () => {
    const missing = ['unit', 'integration', 'acceptance', 'api'].filter(l => !cfg.config.levels?.[l])
    return missing.length === 0 || `undeclared: ${missing.join(', ')}`
  })

  await c.check('standalone skills: every plugin skill plus rig-approve and rig-waive', () => {
    const want = [...names('skills').map(n => `rig-${n}`), 'rig-approve', 'rig-waive']
    const missing = want.filter(n => !sb.exists(`.claude/skills/${n}/SKILL.md`))
    return missing.length === 0 || `missing: ${missing.join(', ')}`
  })
  await c.check('standalone agents: every plugin agent', () => {
    const missing = names('agents', '.md').filter(n => !sb.exists(`.claude/agents/rig-${n}.md`))
    return missing.length === 0 || `missing: ${missing.join(', ')}`
  })
  await c.check('vendored checker is the plugin version', () => {
    const vendored = sb.read('.rig/bin/VERSION').trim()
    return vendored === pluginVersion() || `VERSION ${vendored || '(none)'} vs plugin ${pluginVersion()}`
  })
  await c.check('settings carry every template permission rule', () => {
    const want = json(fs.readFileSync(path.join(PLUGIN, 'templates/settings.json'), 'utf8')).permissions ?? {}
    const have = json(sb.read('.claude/settings.json') || '{}').permissions ?? {}
    const missing = Object.entries(want).flatMap(([kind, rules]) => rules.filter(r => !(have[kind] ?? []).includes(r)).map(r => `${kind} ${r}`))
    return missing.length === 0 || missing.join(', ')
  })
  await c.check('git hooks wired: core.hooksPath is .rig/githooks, both hooks executable', () => {
    const hooksPath = sb.run('git', ['config', 'core.hooksPath']).stdout.trim()
    const bad = ['pre-commit', 'pre-push'].filter(h => !sb.exists(`.rig/githooks/${h}`) || !(fs.statSync(sb.file(`.rig/githooks/${h}`)).mode & 0o111))
    return (hooksPath === '.rig/githooks' && bad.length === 0) || `hooksPath=${hooksPath || '(unset)'} not executable or missing: ${bad.join(', ')}`
  })
  await c.check('preflight report written', () => /result:/.test(sb.read('.rig/PREFLIGHT.md')) || 'no .rig/PREFLIGHT.md')

  await c.check('onboarding committed on main', () => {
    const branch = sb.git('rev-parse', '--abbrev-ref', 'HEAD')
    const tracked = sb.git('ls-files').split('\n')
    const need = ['CLAUDE.md', '.rig/sensors.json', '.rig/bin/sdlc.ts', '.claude/settings.json']
    const untracked = need.filter(f => !tracked.includes(f))
    return (branch === 'main' && untracked.length === 0) || `branch ${branch}; not committed: ${untracked.join(', ')}`
  })
  await c.check('working tree clean after onboarding', () => {
    const dirty = sb.git('status', '--porcelain')
    return dirty === '' || dirty.split('\n').join('; ')
  })
  await c.check('npm test passes on main', () => {
    const r = sb.run('npm', ['test', '--silent'])
    return r.status === 0 || (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' ')
  })

  if (lane === 'greenfield') {
    await c.check('greenfield scaffold: ESM package with test, test-fast and lint scripts', () => {
      const pkg = json(sb.read('package.json') || '{}')
      const missing = ['test', 'test-fast', 'lint'].filter(s => !pkg.scripts?.[s])
      return (pkg.type === 'module' && missing.length === 0) || `type ${pkg.type}; missing scripts: ${missing.join(', ')}`
    })
  }
  if (lane === 'brownfield') {
    await c.check('brownfield CLAUDE.md maps the existing modules', () => {
      const absent = modules.filter(m => !claudeMd.includes(m))
      return absent.length === 0 || `not named: ${absent.join(', ')}`
    })
  }
}
