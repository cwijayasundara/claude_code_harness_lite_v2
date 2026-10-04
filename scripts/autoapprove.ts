// The allow rule (spec §6): inside an approved plan's autonomous nodes, planned edits and declared commands
// run without a prompt. It only turns "ask" into "allow"; the hooks run it after every deny and ask check.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, approvalOf, planFiles, planVerification, relPosix, type HookInput } from './core.ts'
import { step, AUTONOMOUS, activeSlug } from './graph.ts'
import { isProtected } from './sensors.ts'
import { loadConfig } from './check.ts'
import { globToRegex } from './model.ts'
import { normCmd, isHarnessScript, atRoot } from './shell.ts'
import { appendEvent } from './ratchet.ts'

const METACHAR = /[;&|`$<>()\\\x00-\x1f\x7f]/
const ARG = /^[\w./:=@^~,+-]+$/
// Bash expands these before git or gh sees them, so the path check would judge a different string.
const expands = (x: string): boolean => /[*?[\]{}]/.test(x) || x.startsWith('~') || /[=:]~/.test(x)
// Task 9 adds its read-only subcommand (pr-checks); scorecard is read-only here. quality is deterministic: it runs only declared commands.
const SAFE_SUBS = new Set(['status', 'next', 'verify-report', 'diff', 'ratchet show', 'quality', 'scorecard'])
const GIT_SUBS = new Set(['status', 'diff', 'log', 'show', 'rev-parse'])
const GIT_BAD_OPT = /^(?:-C|-c|--no-index|--output(?:=.*)?|--ext-diff|-O.*|--open-files-in-pager.*|--textconv|--exec-path.*|--git-dir.*|--work-tree.*|--paginate)$/

// sensors.json is protected, so its commands always count. plan.md is the model's own file unless the person approved
// it (the approval is bound to its digest), so its ## Verification counts only then.
export function declaredCommandSet(slug: string | null): Set<string> {
  const { config } = loadConfig()
  const cmds = [...Object.values(config.fast), ...Object.values(config.full), ...Object.values(config.levels), ...Object.values(config.quality).map(q => q.cmd), ...(slug && approvalOf(slug, 'plan') === 'approved' ? planVerification(slug) : [])]
  return new Set(cmds.filter((c): c is string => Boolean(c)).map(normCmd))
}

// A path argument must stay inside the repo once `..` and symlinks are resolved.
const inside = (arg: string): boolean => insideRepo(arg) !== null

function gitReadOnly(w: string[]): boolean {
  if (!GIT_SUBS.has(w[1] ?? '')) return false
  return w.slice(2).every(x => ARG.test(x) && !expands(x) && (x.startsWith('-') ? !GIT_BAD_OPT.test(x) && !/^-[a-zA-Z]*[CcO]/.test(x) && !x.includes('/') : inside(x)))
}

// Returns how the command was approved, or null. 'read' means read-only git, which is not worth an audit event.
function bashApproval(cmd: string, slug: string, node: string, cwd?: string): 'declared' | 'read' | null {
  // Judge the raw text: normCmd folds newlines and tabs into spaces, but bash would still run the extra line.
  if (METACHAR.test(cmd) || !atRoot(cwd)) return null
  const c = cmd.trim().replace(/ +/g, ' ')
  if (normCmd(cmd) !== c) return null
  if (declaredCommandSet(slug).has(c)) return 'declared'
  const w = c.split(' ')
  if (w[0] === 'node') {
    const i = w[1]?.startsWith('--disable-warning=ExperimentalWarning') ? 2 : 1
    if (!w[i] || !isHarnessScript(w[i], cwd) || w.slice(1, i).some(x => x !== '--disable-warning=ExperimentalWarning')) return null
    const rest = w.slice(i + 1)
    if (rest[0] === 'run') {
      const m = /^run(?: --slug ([a-z0-9-]+))?(?: --expect-fail)? -- "([^"\\$`\x00-\x1f\x7f]+)"$/.exec(rest.join(' '))
      return m && declaredCommandSet(slug).has(normCmd(m[2] ?? '')) ? 'declared' : null
    }
    const sub = rest[0] === 'ratchet' ? `ratchet ${rest[1] ?? ''}` : rest[0] ?? ''
    const args = rest.slice(rest[0] === 'ratchet' ? 2 : 1)
    return SAFE_SUBS.has(sub) && args.every(x => ARG.test(x) && !expands(x) && !x.split('/').includes('..')) ? 'declared' : null
  }
  if (w[0] === 'git') {
    if (w.join(' ') === `git checkout -b sdlc/${slug}`) return 'declared'
    return gitReadOnly(w) ? 'read' : null
  }
  if (w[0] === 'gh' && (node === 'pr' || node === 'pr-review') && w[1] === 'pr') {
    const branch = `sdlc/${slug}`
    const t = w.slice(2).join(' ')
    if (t === `view ${branch}` || t === `checks ${branch}` || t === `checks ${branch} --json state`) return 'declared'
    // Findings go in exactly this file; any other body file could publish a secret.
    const body = `.sdlc/changes/${slug}/pr-comment.md`
    if (t === `comment ${branch} --body-file ${body}` && insideRepo(body) === body && !fs.lstatSync(path.resolve(ROOT, body), { throwIfNoEntry: false })?.isSymbolicLink()) return 'declared'
  }
  return null
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
  if (!planFiles(slug).length) return null
  const s = step(slug)
  if (s.verdict !== 'continue' || !s.node || !AUTONOMOUS.has(s.node)) return null
  if (tool === 'edit') {
    const file = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '')
    if (!file || /[\x00-\x1f\x7f]/.test(file)) return null
    const rel = insideRepo(file)
    const lexical = relPosix(path.resolve(ROOT, file))
    if (!rel || lexical.startsWith('../') || isProtected(rel, true) || isProtected(lexical, true)) return null
    if (rel.split('/').some(seg => seg.startsWith('.'))) return null // hooks, CI and env files run outside the test runner or hold secrets
    if (!planFiles(slug).some(p => globToRegex(p).test(rel))) return null
    appendEvent(slug, { node: s.node, verdict: 'allow', kind: 'auto-approve', tool: 'Edit', target: rel })
    return `${rel} is inside ${slug}/plan.md ## Files (node ${s.node})`
  }
  const cmd = String(input.tool_input?.command ?? '')
  const how = cmd ? bashApproval(cmd, slug, s.node, input.cwd) : null
  if (!how) return null
  if (how === 'declared') appendEvent(slug, { node: s.node, verdict: 'allow', kind: 'auto-approve', tool: 'Bash', target: normCmd(cmd).slice(0, 120) })
  return `a declared, harness or read-only git command inside ${slug}'s approved plan (node ${s.node})`
}
