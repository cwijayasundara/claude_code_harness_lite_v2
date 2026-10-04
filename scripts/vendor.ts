// Copies the harness into a project. Plain `vendor` copies the checker CI runs (.sdlc/bin). `vendor --standalone`
// (alias --cloud) also writes the skills, agents and hooks into .claude/, so the repo needs no plugin, cloud sessions included.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SDLC, PLUGIN_ROOT, IS_VENDORED, read, out, fail, sanctionWrites, type Args } from './core.ts'

export const VENDORED = ['core', 'graph', 'model', 'sensors', 'diffs', 'runs', 'check', 'ratchet', 'quality', 'levels', 'autoapprove', 'hooks', 'metrics', 'scorecard', 'wiki', 'pr', 'sdlc', 'shell', 'vendor']
const SDLC_HOOK = '.sdlc/bin/sdlc.ts'
type HookGroup = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }

// Plugin references rewritten for a project copy: script paths, /sdlc:x skills, sdlc:x agents and the skill's name.
export function forProject(text: string): string {
  return text
    .replaceAll('${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts', SDLC_HOOK)
    .replaceAll('<plugin>/scripts/sdlc.ts', SDLC_HOOK)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}/templates/', '.sdlc/templates/')
    .replace(/\/sdlc:([a-z][a-z-]*)/g, '/sdlc-$1')
    .replace(/\bsdlc:(?!allow-secret)([a-z][a-z-]*)/g, 'sdlc-$1')
    .replace(/^name: (?!sdlc-)(\S+)$/m, 'name: sdlc-$1')
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
  const settings = (read(file) ? JSON.parse(read(file)) : {}) as { hooks?: Record<string, HookGroup[]> }
  const hooks = settings.hooks ?? {}
  const ours = (g: HookGroup): boolean => g.hooks.some(h => h.command.includes(SDLC_HOOK))
  for (const [event, groups] of Object.entries(plugin.hooks)) {
    const copied = groups.map(g => ({
      ...g,
      hooks: g.hooks.map(h => ({ ...h, command: h.command.replace('${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts', `$CLAUDE_PROJECT_DIR/${SDLC_HOOK}`) })),
    }))
    hooks[event] = [...(hooks[event] ?? []).filter(g => !ours(g)), ...copied]
  }
  writeFile('.claude/settings.json', JSON.stringify({ ...settings, hooks }, null, 2) + '\n', written)
}

// Human-only gates without the mod: the person invokes these, the model cannot (disable-model-invocation), and the
// pre-bash hook denies any model Bash naming SDLC_HUMAN. '$ARGUMENTS' is quoted so the shell never globs or splits it.
function humanSkill(cmd: 'approve' | 'waive', hint: string, what: string): string {
  const run = `SDLC_HUMAN=1 node --disable-warning=ExperimentalWarning ${SDLC_HOOK} ${cmd}`
  return [
    '---', `name: sdlc-${cmd}`, `description: Human only. ${what} The model cannot run this.`, `argument-hint: ${hint}`,
    'disable-model-invocation: true', `allowed-tools: Bash(${run} *)`, '---',
    `!\`${run} '$ARGUMENTS' 2>&1\``, '', 'Tell the person the result above in one line. Do nothing else.', '',
  ].join('\n')
}

function vendorStandalone(written: string[]): void {
  for (const name of fs.readdirSync(path.join(PLUGIN_ROOT, 'skills'))) {
    const src = path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md')
    if (fs.existsSync(src)) writeFile(`.claude/skills/sdlc-${name}/SKILL.md`, forProject(read(src)), written)
  }
  writeFile('.claude/skills/sdlc-approve/SKILL.md', humanSkill('approve', '<slug> <spec|plan|impact|budget>', 'Approve a gated sdlc artifact.'), written)
  writeFile('.claude/skills/sdlc-waive/SKILL.md', humanSkill('waive', '<sensor> <file|*> <reason>', 'Waive a sensor finding for the active change.'), written)
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'agents')).filter(f => f.endsWith('.md'))) {
    writeFile(`.claude/agents/sdlc-${file}`, forProject(read(path.join(PLUGIN_ROOT, 'agents', file))), written)
  }
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'templates'))) {
    writeFile(`.sdlc/templates/${file}`, read(path.join(PLUGIN_ROOT, 'templates', file)), written)
  }
  mergeHooks(written)
}

export function cmdVendor(args: Args): void {
  if (IS_VENDORED) fail('run vendor from the sdlc plugin, not from a project copy')
  const written: string[] = []
  for (const name of VENDORED) writeFile(`.sdlc/bin/${name}.ts`, read(path.join(PLUGIN_ROOT, 'scripts', `${name}.ts`)), written)
  const version = (JSON.parse(read(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))) as { version?: string }).version ?? 'unknown'
  writeFile('.sdlc/bin/VERSION', `${version}\n`, written)
  const standalone = Boolean(args.opt.standalone || args.opt.cloud)
  if (standalone) vendorStandalone(written)
  sanctionWrites(written)
  out(standalone
    ? `vendored sdlc ${version} standalone: .sdlc/bin, .claude/skills/sdlc-*, .claude/agents/sdlc-*, hooks in .claude/settings.json. Commit .sdlc/ and .claude/; re-run from the plugin to upgrade.`
    : `vendored sdlc ${version} into ${path.relative(ROOT, path.join(SDLC, 'bin'))} (${VENDORED.length} files). Commit it; CI runs the base branch's copy.`)
}
