// The allow rule (spec §6): inside an approved plan's autonomous nodes, planned edits and declared commands
// run without a prompt. It only turns "ask" into "allow"; the hooks run it after every deny and ask check.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, approvalOf, planFiles, planVerification, relPosix, type HookInput } from './core.ts'
import { step, AUTONOMOUS, activeSlug } from './graph.ts'
import { isProtected } from './sensors.ts'
import { loadConfig } from './check.ts'
import { globToRegex } from './model.ts'
import { readOnlyDenial, normCmd } from './shell.ts'
import { appendEvent } from './ratchet.ts'

const SCRIPT_RUN = /^node(?: --disable-warning=ExperimentalWarning)? [\w./-]*sdlc\.ts run(?: --slug [a-z0-9-]+)?(?: --expect-fail)? -- "([^"\\$`\x00-\x1f\x7f]+)"$/
const SCRIPT_SAFE = /^node(?: --disable-warning=ExperimentalWarning)? [\w./-]*sdlc\.ts (?:status|next|verify-report|ratchet record|ratchet show|quality|scorecard|pr-checks|diff)(?: [\w./:=-]+)*$/
const METACHAR = /[;&|`$<>()\\\x00-\x1f\x7f]/

export function declaredCommandSet(slug: string | null): Set<string> {
  const { config } = loadConfig()
  const cmds = [...Object.values(config.fast), ...Object.values(config.full), ...Object.values(config.levels), ...Object.values(config.quality).map(q => q.cmd), ...(slug ? planVerification(slug) : [])]
  return new Set(cmds.filter((c): c is string => Boolean(c)).map(normCmd))
}

function bashAllowed(cmd: string, slug: string): boolean {
  // Judge the raw text: normCmd folds newlines and tabs into spaces, but bash would still run the extra line.
  if (METACHAR.test(cmd)) return false
  const c = cmd.trim().replace(/ +/g, ' ')
  if (normCmd(cmd) !== c) return false
  const declared = declaredCommandSet(slug)
  if (declared.has(c)) return true
  const run = SCRIPT_RUN.exec(c)
  if (run) return declared.has(normCmd(run[1] ?? ''))
  if (SCRIPT_SAFE.test(c)) return true
  if (METACHAR.test(c)) return false
  return readOnlyDenial(c, 'auto-approve', () => declared) === null
}

// The repo-relative path of a file after resolving `..` and symlinks (through the nearest existing ancestor), or null when it leaves the repo.
function insideRepo(file: string): string | null {
  const abs = path.resolve(ROOT, file)
  let probe = abs
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe)
  let real: string
  let root: string
  try { real = path.join(fs.realpathSync(probe), path.relative(probe, abs)); root = fs.realpathSync(ROOT) } catch { return null }
  const rel = path.relative(root, real).split(path.sep).join('/')
  return !rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) ? null : rel
}

export function autoApprove(input: HookInput, tool: 'edit' | 'bash'): string | null {
  const slug = activeSlug()
  if (!slug) return null
  if (approvalOf(slug, 'plan') !== 'approved') return null
  const s = step(slug)
  if (s.verdict !== 'continue' || !s.node || !AUTONOMOUS.has(s.node)) return null
  if (tool === 'edit') {
    const file = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '')
    if (!file || /[\x00-\x1f\x7f]/.test(file)) return null
    const rel = insideRepo(file)
    const lexical = relPosix(path.resolve(ROOT, file))
    if (!rel || lexical.startsWith('../') || isProtected(rel, true) || isProtected(lexical, true)) return null
    if (rel.toLowerCase().startsWith('.sdlc/') || rel.toLowerCase().startsWith('.git/') || rel.toLowerCase().startsWith('.claude/')) return null
    if (!planFiles(slug).some(p => globToRegex(p).test(rel))) return null
    appendEvent(slug, { node: s.node, verdict: 'allow', kind: 'auto-approve', tool: 'Edit', target: rel })
    return `${rel} is in ${slug}/plan.md ## Files and the plan is approved (node ${s.node})`
  }
  const cmd = String(input.tool_input?.command ?? '')
  if (!cmd || !bashAllowed(cmd, slug)) return null
  appendEvent(slug, { node: s.node, verdict: 'allow', kind: 'auto-approve', tool: 'Bash', target: normCmd(cmd).slice(0, 120) })
  return `a declared or read-only command inside ${slug}'s approved plan (node ${s.node})`
}
