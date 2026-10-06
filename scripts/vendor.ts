// Copies the harness into a project. Plain `vendor` copies the checker CI runs (.sdlc/bin). `vendor --standalone`
// (alias --cloud) also writes the skills, agents and hooks into .claude/, so the repo needs no plugin, cloud sessions included.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SDLC, PLUGIN_ROOT, IS_VENDORED, read, out, fail, sanctionWrites, type Args } from './core.ts'
import { writeHookScripts, installHooks } from './githooks.ts'

export const VENDORED = ['core', 'graph', 'model', 'sensors', 'diffs', 'runs', 'check', 'ratchet', 'stamp', 'slicecheck', 'shards', 'quality', 'basetree', 'levels', 'verify', 'autoapprove', 'hooks', 'metrics', 'scorecard', 'flow', 'pr', 'sdlc', 'shell', 'githooks', 'vendor']
const SDLC_HOOK = '.sdlc/bin/sdlc.ts'
type HookGroup = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }

// Plugin references rewritten for a project copy: script paths, /rig:x skills, rig:x agents and the skill's name.
export function forProject(text: string): string {
  return text
    .replaceAll('${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts', SDLC_HOOK)
    .replaceAll('<plugin>/scripts/sdlc.ts', SDLC_HOOK)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}/workflows/', '.claude/workflows/')
    .replaceAll('${CLAUDE_PLUGIN_ROOT}/templates/', '.sdlc/templates/')
    .replace(/\/rig:([a-z][a-z-]*)/g, '/rig-$1')
    .replace(/\brig:(?!allow-secret)([a-z][a-z-]*)/g, 'rig-$1')
    .replace(/^name: (?!rig-)(\S+)$/m, 'name: rig-$1')
}

function writeFile(rel: string, text: string, written: string[]): void {
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true })
  fs.writeFileSync(path.join(ROOT, rel), text)
  written.push(rel)
}

// The plugin's settings hooks, pointed at the project copy and merged into .claude/settings.json. A re-run replaces
// the previous sdlc entries; the project's own hooks and other settings are kept.
function mergeHooks(written: string[]): void {
  const plugin = JSON.parse(read(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'))) as { hooks: Record<string, HookGroup[]> }
  const file = path.join(ROOT, '.claude', 'settings.json')
  const settings = (read(file) ? JSON.parse(read(file)) : {}) as { hooks?: Record<string, HookGroup[]>; extraKnownMarketplaces?: object; enabledPlugins?: Record<string, boolean> }
  const hooks = settings.hooks ?? {}
  const ours = (g: HookGroup): boolean => g.hooks.some(h => h.command.includes(SDLC_HOOK))
  for (const [event, groups] of Object.entries(plugin.hooks)) {
    const copied = groups.map(g => ({
      ...g,
      hooks: g.hooks.map(h => ({ ...h, command: h.command.replace('${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts', `$CLAUDE_PROJECT_DIR/${SDLC_HOOK}`) })),
    }))
    hooks[event] = [...(hooks[event] ?? []).filter(g => !ours(g)), ...copied]
  }
  const merged = {
    ...settings, hooks,
    extraKnownMarketplaces: { ...settings.extraKnownMarketplaces, 'rig-local': { source: { source: 'directory', path: '.' } } },
    enabledPlugins: { ...settings.enabledPlugins, 'rig-mod@rig-local': true },
  }
  writeFile('.claude/settings.json', JSON.stringify(merged, null, 2) + '\n', written)
}

// Human-only gates without the mod: the person invokes these, the model cannot (disable-model-invocation), and the
// pre-bash hook denies any model Bash naming SDLC_HUMAN. '$ARGUMENTS' is quoted so the shell never globs or splits it.
function humanSkill(cmd: 'approve' | 'waive', hint: string, what: string): string {
  const run = `SDLC_HUMAN=1 node --disable-warning=ExperimentalWarning ${SDLC_HOOK} ${cmd}`
  return [
    '---', `name: rig-${cmd}`, `description: Human only. ${what} The model cannot run this.`, `argument-hint: ${hint}`,
    'disable-model-invocation: true', `allowed-tools: Bash(${run} *)`, '---',
    `!\`${run} '$ARGUMENTS' 2>&1\``, '', 'Tell the person the result above in one line. Do nothing else.', '',
  ].join('\n')
}

function vendorStandalone(written: string[], version: string): void {
  for (const name of fs.readdirSync(path.join(PLUGIN_ROOT, 'skills'))) {
    const src = path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md')
    if (fs.existsSync(src)) writeFile(`.claude/skills/rig-${name}/SKILL.md`, forProject(read(src)), written)
  }
  writeFile('.claude/skills/rig-approve/SKILL.md', humanSkill('approve', '<slug> <design|spec|plan|impact|budget|tier S|M|L [type]>', 'Approve a gated sdlc artifact.'), written)
  writeFile('.claude/skills/rig-waive/SKILL.md', humanSkill('waive', '<sensor> <file|*> <reason>', 'Waive a sensor finding for the active change.'), written)
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'agents')).filter(f => f.endsWith('.md'))) {
    writeFile(`.claude/agents/rig-${file}`, forProject(read(path.join(PLUGIN_ROOT, 'agents', file))), written)
  }
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'templates'))) {
    writeFile(`.sdlc/templates/${file}`, read(path.join(PLUGIN_ROOT, 'templates', file)), written)
  }
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'workflows')).filter(f => f.endsWith('.js'))) {
    writeFile(`.claude/workflows/${file}`, read(path.join(PLUGIN_ROOT, 'workflows', file)), written)
  }
  for (const f of fs.readdirSync(path.join(PLUGIN_ROOT, 'hooks')).filter(f => /\.(?:ts|tsx)$/.test(f))) writeFile(`.sdlc/mod/hooks/${f}`, read(path.join(PLUGIN_ROOT, 'hooks', f)), written)
  writeFile('.sdlc/mod/hooks/hooks.json', JSON.stringify({ modules: ['./register.ts'] }, null, 2) + '\n', written)
  writeFile('.sdlc/mod/.claude-plugin/plugin.json', JSON.stringify({ name: 'rig-mod', version }, null, 2) + '\n', written)
  writeFile('.sdlc/mod/types/index.d.ts', read(path.join(PLUGIN_ROOT, 'types', 'index.d.ts')), written)
  writeFile('.claude-plugin/marketplace.json', JSON.stringify({ name: 'rig-local', owner: { name: 'sdlc' }, plugins: [{ name: 'rig-mod', source: './.sdlc/mod' }] }, null, 2) + '\n', written)
  mergeHooks(written)
}

const older = (a: string, b: string): boolean => {
  const [x, y] = [a, b].map(v => v.split('.').map(n => Number.parseInt(n, 10) || 0))
  for (let i = 0; i < 3; i++) if ((x?.[i] ?? 0) !== (y?.[i] ?? 0)) return (x?.[i] ?? 0) < (y?.[i] ?? 0)
  return false
}

export function cmdVendor(args: Args): void {
  if (IS_VENDORED) fail('run vendor from the sdlc plugin, not from a project copy')
  if (older(process.versions.node, '22.18.0')) fail(`rig needs Node >= 22.18 (this is ${process.versions.node}); on an older Node its hooks fail silently and every gate is off`)
  const have = read(path.join(SDLC, 'bin', 'VERSION')).trim()
  const next = (JSON.parse(read(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))) as { version?: string }).version ?? 'unknown'
  if (have && older(next, have) && !args.opt.force) fail(`.sdlc/bin is ${have}, newer than this plugin (${next}); upgrade the plugin first, or pass --force to downgrade`)
  try { if (read(path.join(ROOT, '.claude', 'settings.json'))) JSON.parse(read(path.join(ROOT, '.claude', 'settings.json'))) } catch { fail('.claude/settings.json is not plain JSON (comments or trailing commas?); fix it first so vendoring does not leave a half-written tree') }
  const written: string[] = []
  for (const name of VENDORED) writeFile(`.sdlc/bin/${name}.ts`, read(path.join(PLUGIN_ROOT, 'scripts', `${name}.ts`)), written)
  writeHookScripts(written)
  const version = (JSON.parse(read(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))) as { version?: string }).version ?? 'unknown'
  writeFile('.sdlc/bin/VERSION', `${version}\n`, written)
  const standalone = Boolean(args.opt.standalone || args.opt.cloud)
  if (standalone) vendorStandalone(written, version)
  sanctionWrites(written)
  out(standalone
    ? `vendored sdlc ${version} standalone: .sdlc/bin, .claude/skills/rig-*, .claude/agents/rig-*, the mod in .sdlc/mod, hooks in .claude/settings.json. Commit .sdlc/ and .claude/; re-run from the plugin to upgrade.`
    : `vendored sdlc ${version} into ${path.relative(ROOT, path.join(SDLC, 'bin'))} (${VENDORED.length} files). Commit it; CI runs the base branch's copy.`)
}

// Settings the template wants, merged under what the project already has: arrays are unioned and a key the project
// already sets keeps its value, so onboarding never overrides a team's own choice.
function mergeMissing(into: Record<string, unknown>, from: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(from)) {
    const have = into[k]
    if (Array.isArray(v)) into[k] = [...new Set([...(Array.isArray(have) ? have : []), ...v])]
    else if (v && typeof v === 'object') into[k] = mergeMissing(have && typeof have === 'object' && !Array.isArray(have) ? have as Record<string, unknown> : {}, v as Record<string, unknown>)
    else if (have === undefined) into[k] = v
  }
  return into
}

// `init --full [--workflows]`: the deterministic half of onboarding, so the model need not hand-copy files. Vendors the
// standalone harness, wires the git hooks and merges templates/settings.json. The CI workflows and REVIEW.md need a
// remote, so they are written only with --workflows, and never over a file that is already there.
export function installStandalone(workflows: boolean): string {
  cmdVendor({ pos: [], opt: { standalone: true } })
  const hooks = installHooks()
  const lines = [hooks.ok ? hooks.message : `git hooks not installed: ${hooks.message}`]
  const file = path.join(ROOT, '.claude', 'settings.json')
  const { $comment: _comment, ...template } = JSON.parse(read(path.join(PLUGIN_ROOT, 'templates', 'settings.json'))) as Record<string, unknown>
  const merged = mergeMissing(JSON.parse(read(file) || '{}') as Record<string, unknown>, template)
  const written: string[] = []
  writeFile('.claude/settings.json', JSON.stringify(merged, null, 2) + '\n', written)
  lines.push('merged templates/settings.json into .claude/settings.json (existing values kept)')
  if (workflows) {
    for (const [from, to] of [['rig-check.yml', '.github/workflows/rig-check.yml'], ['rig-review.yml', '.github/workflows/rig-review.yml'], ['REVIEW.md', 'REVIEW.md']] as const) {
      if (fs.existsSync(path.join(ROOT, to))) lines.push(`${to} already exists; left as it is`)
      else { writeFile(to, read(path.join(PLUGIN_ROOT, 'templates', from)), written); lines.push(`wrote ${to}`) }
    }
  }
  sanctionWrites(written)
  return lines.join('\n')
}
