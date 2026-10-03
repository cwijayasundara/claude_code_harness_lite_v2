// sdlc settings hooks: read the hook event JSON on stdin, decide, and print the hook's JSON answer.
import fs from 'node:fs'
import {
  SDLC, STATE, exists, read, out, fail, frontmatter, toPosix, activeSlug, loadChange, nextCommand,
  planFiles, isPlanned, relPosix, scanSecrets, planProblems, type Args, type HookInput,
} from './core.ts'

function readStdin(): HookInput {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') as HookInput
  } catch {
    return {}
  }
}

function decide(decision: 'allow' | 'ask' | 'deny', reason: string): void {
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }))
}

function hookSessionStart(): void {
  if (!exists(SDLC)) return
  const active = activeSlug()
  const c = active ? loadChange(active) : null
  const state = frontmatter(read(STATE)).body.trim().split('\n').slice(0, 15).join('\n')
  const context = [
    'sdlc harness is active in this repo (artifacts in .sdlc/).',
    c ? `Active change: ${c.slug} (${c.type}, tier ${c.tier}). Next: ${nextCommand(c)}` : 'No active change. Start one with /sdlc:start "<request>".',
    'Rules: plans hold interfaces + acceptance tests, never code; delegate searches to sdlc:scout and slices to sdlc:implementer; read .sdlc/approvals.jsonl with the Read tool (only the person writes it); run subagents in the foreground and never end a turn while one is running; never sleep-poll; at ~150k context run /sdlc:handoff.',
    state && state !== '# State' ? `STATE.md:\n${state}` : '',
  ].filter(Boolean)
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.join('\n') } }))
}

// git (staging, committing, inspecting) and read-only viewers may name the approvals log; nothing that can write to it may.
const SAFE_APPROVALS_COMMAND = /^\s*(?:git\s+(?:add|commit|status|diff|log|show)|cat|head|tail|wc|grep|rg)\b/
const WRITES = /(?:>|\btee\b|\bsed\s+-i|\b(?:python3?|node|perl|ruby|bash|sh|zsh|pwsh|powershell)\b|\b(?:cp|mv|rm|truncate|dd)\b|\b(?:checkout|restore|reset|apply|stash)\b)/

function isSafeApprovalsCommand(cmd: string): boolean {
  return cmd
    .split(/&&|\|\||;|\|/)
    .filter(part => /approvals\.jsonl/.test(part))
    .every(part => SAFE_APPROVALS_COMMAND.test(part) && !WRITES.test(part.replace(/^\s*git\s+commit\b[^]*?-m\s+(["']).*?\1/, '')))
}

function hookPreBash(input: HookInput): void {
  const cmd = String(input.tool_input?.command ?? '')
  if (/sdlc\.(?:m?js|ts)["']?\s+approve\b/.test(cmd) || (/approvals\.jsonl/.test(cmd) && !isSafeApprovalsCommand(cmd))) {
    return decide('deny', 'Approvals are human-only. Read approvals.jsonl with the Read tool; only the person writes it, with /sdlc-approve <slug> <stage>.')
  }
  if (!exists(SDLC)) return
  const sleep = /(?:^|[;&|]\s*|\s)(?:sleep|Start-Sleep(?:\s+-Seconds)?)\s+(\d+)/i.exec(cmd)
  if (sleep && Number(sleep[1]) >= 30) {
    return decide('deny', 'Do not sleep-poll: background agents and shells notify you when they finish. End the turn or do other useful work.')
  }
}

function hookPreEdit(input: HookInput): void {
  const file = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '')
  if (!file) return
  if (toPosix(file).endsWith('.sdlc/approvals.jsonl')) {
    return decide('deny', 'approvals.jsonl is written only by the human /sdlc-approve command.')
  }
  if (!exists(SDLC)) return
  const slug = activeSlug()
  if (!slug) return
  const stage = loadChange(slug).next?.stage
  if (stage !== 'build' && stage !== 'diagnose') return
  const patterns = planFiles(slug)
  if (patterns.length && !isPlanned(file, patterns)) {
    return decide('ask', `${relPosix(file)} is not in ${slug}/plan.md ## Files. Add it to the plan if it belongs to this change, otherwise leave it alone.`)
  }
}

function hookPostEdit(input: HookInput): void {
  const file = String(input.tool_input?.file_path ?? '')
  if (!file || !exists(file)) return
  const problems = scanSecrets(file)
  if (exists(SDLC) && /\.sdlc\/changes\/[^/]+\/plan\.md$/.test(toPosix(file))) problems.push(...planProblems(file).map(p => `${file}: ${p}`))
  if (problems.length) {
    process.stderr.write(`sdlc check failed, fix before continuing:\n${problems.join('\n')}\n`)
    process.exitCode = 2
  }
}

const HOOKS: Record<string, (input: HookInput) => void> = {
  'session-start': hookSessionStart,
  'pre-bash': hookPreBash,
  'pre-edit': hookPreEdit,
  'post-edit': hookPostEdit,
}

export function cmdHook(args: Args): void {
  const handler = HOOKS[args.pos[0] ?? '']
  if (!handler) fail(`unknown hook ${args.pos[0]}`)
  handler(readStdin())
}
