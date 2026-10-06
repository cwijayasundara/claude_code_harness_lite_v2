// The git-hook bypass guard for pre-bash: whether a Bash command switches the rig git hooks off. Best effort; CI is
// the floor. It reads dequoted words from the shell.ts tokenizer, so quotes and escapes cannot hide a flag.
import { tokenize } from './shell.ts'
import { SHELL_NAMES, tick, startBudget, overBudget, endBudget, inert, unquote, expandWord, topLevel } from './inert.ts'

// The model may not switch the git hooks off (only the person does): --no-verify on commit or push (any prefix),
// -n on commit, core.hooksPath in any spelling or scope, an alias that adds either, or rig's own uninstall / install --force.
// Read on dequoted words; what tokenize refuses is made readable by inert() first, and only the rest gets the regex.
const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'])
const COMMIT_VALUE = new Set(['-m', '-F', '-C', '-c', '-t', '--message', '--file', '--author', '--date', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--cleanup', '--trailer', '--template'])
const MESSAGE = new Set(['-m', '-F', '--message', '--file'])
const HOOKS_PATH = /core\.hookspath/i
const noVerify = (w: string): boolean => w.startsWith('--no-v') && !w.startsWith('--no-verb')

// Option words of a commit or push, minus message values; true when one skips the hooks.
function optionsBypass(sub: string, args: string[], scanned: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const w = args[i] ?? ''
    if (w === '--') break
    if (sub === 'commit' && COMMIT_VALUE.has(w)) {
      if (!MESSAGE.has(w)) scanned.push(args[i + 1] ?? '')
      i++
      continue
    }
    if (/^--(?:message|file)=/.test(w) || (sub === 'commit' && /^-[mF]/.test(w))) continue
    scanned.push(w)
    if (noVerify(w)) return true
    if (sub !== 'commit' || !/^-[^-]/.test(w)) continue
    for (let j = 1; j < w.length; j++) {
      const ch = w[j] ?? ''
      if (ch === 'n') return true
      if ('mFCctuS'.includes(ch)) {
        if (j === w.length - 1 && 'mFCct'.includes(ch)) i++ // a value-taking letter last: the value is the next word
        break
      }
    }
  }
  return false
}

function aliasBypass(words: string[], depth: number): boolean {
  return words.some((w, i) => {
    const m = /^alias\.[^=]*(?:=([^]*))?$/i.exec(w)
    if (!m) return false
    const value = m[1] ?? words[i + 1] ?? ''
    return reads(value.startsWith('!') ? value.slice(1) : `git ${value}`, depth + 1)
  })
}

const SHELLS = new RegExp(`^(?:${SHELL_NAMES})$`, 'i')
// A program's name as a case-insensitive filesystem (macOS, Windows) finds it: GIT, /usr/bin/Git and git.exe run git.
const progName = (w: string): string => (w.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')
// The fallback for text the tokenizer refuses: quoted strings not starting with - are blanked for the flags (a message
// that mentions --no-verify is fine), and core.hooksPath must share a line with git.
function regexBypass(text: string): boolean {
  tick()
  const flags = text.replace(/"([^"]*)"|'([^']*)'/g, (_m, a?: string, b?: string) => ((a ?? b ?? '').startsWith('-') ? ` ${a ?? b} ` : '""'))
  const plain = text.replace(/["'\\]/g, '')
  return flags.split(/[;&|\n]/).some(flagsLine) || plain.split(/[;&|\n]/).some(plainLine)
}
// The regexes, read line by line in linear time (a nested-quantifier regex took seconds on 15 KB): within one command
// line, the first git and the first commit or push after it leave the longest tail, so testing that tail is the same.
const after = (s: string, re: RegExp): string | null => {
  const m = re.exec(s)
  return m ? s.slice(m.index + m[0].length) : null
}
function flagsLine(line: string): boolean { // git ... commit ... --no-v or -..n..; git ... push ... --no-v
  const g = after(line, /\bgit\b/i)
  if (g === null) return false
  const c = after(g, /\bcommit\b/i)
  if (c !== null && (/--no-v/i.test(c) || c.split(/\s+/).slice(1).some(w => /^-[a-zA-Z]+$/.test(w) && /n/i.test(w)))) return true
  const p = after(g, /\bpush\b/i)
  return p !== null && /--no-v/i.test(p)
}
function plainLine(line: string): boolean { // git ... core.hooksPath; sdlc.ts ... hooks uninstall | install ... --force
  const g = after(line, /\bgit\b/i)
  if (g !== null && /core\.hookspath/i.test(g)) return true
  const s = after(line, /sdlc\.(?:m?js|ts)\b/)
  if (s === null) return false
  const force = s.lastIndexOf('--force')
  for (const m of s.matchAll(/\bhooks\s+(uninstall|install)\b/g)) if (m[1] === 'uninstall' || m.index < force) return true
  return false
}
// A git command at the start of one word (an argument of another program, e.g. watch 'git ...') gets the regex.
const embeddedGit = (words: string[]): boolean => words.some(w => /^\s*git(?:\.exe)?\s/i.test(w) && regexBypass(w))

// Programs that run their first operand as the command, with the options that take a separate value.
const WRAPPERS = new Map<string, string[]>([
  ['env', ['-u', '-C', '-S', '--unset', '--chdir', '--split-string']],
  ['sudo', ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '-R', '--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type', '--other-user']],
  ['xargs', ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--arg-file', '--delimiter']],
  ['timeout', ['-s', '-k', '--signal', '--kill-after']], ['nice', ['-n', '--adjustment']], ['exec', ['-a']],
  ['nohup', []], ['time', []], ['command', []], ['builtin', []], ['setsid', []], ['stdbuf', ['-i', '-o', '-e']],
  ['doas', ['-u', '-C']], ['caffeinate', ['-t', '-w']], ['arch', ['-e', '-d']], ['ionice', ['-c', '-n', '-p']], ['chroot', ['--userspec', '--groups']],
])
// Reserved words a command can follow (the tokenizer splits on ; so `then`, `do` and the like start a segment).
const RESERVED = new Set(['!', 'if', 'then', 'elif', 'else', 'do', 'while', 'until'])
const SHELL_VALUE = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])

type Payload = { text: string; words: string[] } // a command line a segment runs, and the words it came from
// The value of an option written attached (-S'...', -c'...', --command=...), or null.
const attached = (o: string, short: string, long: string): string | null =>
  o.startsWith(`${long}=`) ? o.slice(long.length + 1) : o.startsWith(short) && o.length > short.length && !o.startsWith('--') ? o.slice(short.length) : null

// Where the program a segment really runs stands, past reserved words, assignments and the wrappers above with their
// options (a cluster such as sudo -Eu takes a value when its last letter does); and env -S's command line.
function programAt(seg: string[]): { k: number; lines: Payload[] } {
  let k = 0
  const lines: Payload[] = []
  for (;;) {
    while (/^\w+=/.test(seg[k] ?? '') || RESERVED.has(seg[k] ?? '')) k++
    const name = progName(seg[k] ?? '')
    const takes = WRAPPERS.get(name)
    if (!takes) return { k, lines }
    k++
    while ((seg[k] ?? '').startsWith('-')) {
      const o = seg[k++] ?? ''
      if (o === '--') break
      // As getopt reads a short cluster: the first value-taking letter takes the rest of the word, or the next word.
      let letter = ''
      let value: string | null = null
      if (/^-[^-]/.test(o)) {
        const j = [...o.slice(1)].findIndex(ch => takes.includes(`-${ch}`)) + 1
        if (j > 0) (letter = o[j] ?? ''), (value = o.slice(j + 1) || null)
      } else if (takes.includes(o)) letter = o
      else value = attached(o, '-S', '--split-string') // --split-string=...; other long options with = take nothing more
      if (letter && value === null) k++ // the value is the next word
      const line = letter === 'S' || letter === '--split-string' ? (value ?? seg[k - 1] ?? '') : !letter && value !== null ? value : null
      if (name === 'env' && line !== null) lines.push({ text: line, words: [value === null ? seg[k - 1] ?? '' : o] })
    }
    if (name === 'timeout' || name === 'chroot') k++ // the duration, the new root
  }
}

// The command lines a segment runs of its own: the word after the -c cluster (and an optional --) of a shell that is
// the program really run (so env, sudo -u x, xargs, nohup, timeout N, nice or time cannot hide it, and a word named sh
// among git's arguments is not one); su's -c or --command value, attached or not; env -S's value; or the words after
// eval (behind command or builtin).
function payloads(seg: string[]): Payload[] {
  const { k, lines: found } = programAt(seg)
  const w = seg[k] ?? ''
  const word = (p: number): void => { if (p < seg.length) found.push({ text: seg[p] ?? '', words: [seg[p] ?? ''] }) }
  if (w === 'eval') found.push({ text: seg.slice(k + 1).join(' '), words: seg.slice(k + 1) })
  else if (progName(w) === 'su') {
    for (let i = k + 1; i < seg.length; i++) {
      const x = seg[i] ?? ''
      const value = attached(x, '-c', '--command')
      if (value !== null) found.push({ text: value, words: [x] })
      else if (x === '-c' || x === '--command') word(i + 1)
    }
  } else if (SHELLS.test(progName(w))) {
    // With -c anywhere among the shell's options, the first operand after them is the command (-o and -O take a value).
    let c = false
    let i = k + 1
    for (; i < seg.length; i++) {
      const o = seg[i] ?? ''
      if (o === '--') { i++; break }
      if (!/^[-+]./.test(o)) break
      if (SHELL_VALUE.has(o)) { i++; continue }
      const cl = /^[-+]([a-zA-Z]+)$/.exec(o)?.[1]
      if (!cl) continue
      if (o.startsWith('-') && cl.includes('c')) c = true
      if ([...cl].findIndex(ch => ch === 'o' || ch === 'O') === cl.length - 1) i++
    }
    if (c) word(i)
  }
  return found
}

function segmentBypasses(seg: string[], depth: number): boolean {
  tick()
  // A payload is read the same way, bounded; past the bound it is denied (nested), never passed unread.
  const runs = payloads(seg)
  if (runs.some(run => deeper(run.text, depth))) return true
  // The whole segment is read as usual too (never masked); only the embedded-git heuristic skips the payload words,
  // which were just read exactly.
  const skip = new Set(runs.flatMap(run => run.words))
  const embedded = (words: string[]): boolean => embeddedGit(words.filter(w => !skip.has(w)))
  const s = seg.findIndex(w => /sdlc\.(?:m?js|ts)$/.test(w))
  const h = seg.indexOf('hooks', s + 1)
  if (s >= 0 && h > s && (seg[h + 1] === 'uninstall' || (seg[h + 1] === 'install' && seg.includes('--force')))) return true
  // Where git stands: the first git word, and the program word when a substitution or variable stands there (the
  // inert _), since $(echo git) or $GIT may name git.
  const k = programAt(seg).k
  const at = [seg.findIndex(w => progName(w) === 'git'), seg[k] === '_' ? k : -1].filter(g => g >= 0)
  if (!at.length) return seg.some(w => /^\w+=/.test(w) && HOOKS_PATH.test(w)) || embedded(seg)
  return at.some(g => gitBypasses(seg, g, depth, embedded))
}

// The words of a git command at seg[g]: its global options, then a commit or push's option words, else every word.
function gitBypasses(seg: string[], g: number, depth: number, embedded: (words: string[]) => boolean): boolean {
  const scanned = seg.slice(0, g)
  let i = g + 1
  while ((seg[i] ?? '').startsWith('-')) {
    scanned.push(seg[i] ?? '')
    if (GIT_GLOBAL_VALUE.has(seg[i] ?? '')) scanned.push(seg[++i] ?? '')
    i++
  }
  const sub = seg[i] ?? ''
  const args = seg.slice(i + 1)
  if (sub === 'commit' || sub === 'push') {
    if (optionsBypass(sub, args, scanned)) return true
  } else scanned.push(sub, ...args)
  return scanned.some(w => HOOKS_PATH.test(w)) || aliasBypass(scanned, depth) || embedded(scanned)
}

// Limits, each failing closed (the command is denied as 'limit', never passed): a command over MAX_COMMAND characters;
// more than BUDGET_MS of work (checked as it goes by tick(), and again at the end); brace expansion past its caps
// (inert.ts); and anything that throws, such as nesting deeper than the stack. The depth bound for shells and evals is
// 'nested' (also denied).
const MAX_COMMAND = 128 * 1024
const BUDGET_MS = 100

let nestedTooDeep = false
// Why the model may not run cmd: 'bypass', 'nested' (shells or evals more than three deep), 'limit' (too large, deep or
// slow to read), or null.
// budgetMs and now are for tests; a scan that ends past the deadline (a step tick() could not interrupt) is denied too.
export function gitHooksBypass(cmd: string, budgetMs = BUDGET_MS, now = (): number => performance.now()): 'bypass' | 'nested' | 'limit' | null {
  nestedTooDeep = false
  if (cmd.length > MAX_COMMAND) return 'limit'
  startBudget(budgetMs, now)
  try {
    const bypass = reads(cmd)
    if (overBudget()) return 'limit'
    return bypass ? (nestedTooDeep ? 'nested' : 'bypass') : null
  } catch {
    return 'limit'
  } finally {
    endBudget()
  }
}
export const bypassesGitHooks = (cmd: string): boolean => gitHooksBypass(cmd) !== null

// The last resort, for text even inert() cannot follow: the regex, and the words a shell -c or eval runs, unquoted
// and read again one layer deeper (past the bound: denied).
// Linear by construction: the shell word is found once, then its words are read one at a time (no nested quantifiers).
const SHELL_AT = new RegExp(`(?:^|[\\s;&|(\`/])(?:${SHELL_NAMES})(?:\\.exe)?(?=\\s)`, 'gi')
const NEXT_WORD = /[ \t]+((?:'[^']*'|"(?:[^"\\]|\\[^])*"|\\[^]|[^\s;&|'"\\])+)/y
function shellPayloads(cmd: string): string[] {
  const found: string[] = []
  for (const m of cmd.matchAll(SHELL_AT)) {
    NEXT_WORD.lastIndex = m.index + m[0].length
    for (let w = NEXT_WORD.exec(cmd); w; w = NEXT_WORD.exec(cmd)) {
      tick()
      const word = w[1] ?? ''
      if (!/^[-+]/.test(word)) break
      if (/^-[a-zA-Z]+$/.test(word) && word.includes('c')) {
        let p = NEXT_WORD.exec(cmd)
        if (p?.[1] === '--') p = NEXT_WORD.exec(cmd)
        if (p) found.push(unquote(p[1] ?? ''))
        break
      }
    }
  }
  return found
}
const EVAL_PAYLOAD = /(?:^|[\s;&|(`])eval\s+([^;&|\n]+)/g
function lastResort(cmd: string, depth: number): boolean {
  tick()
  if (regexBypass(cmd)) return true
  // One construct nothing can follow must not hide the other commands: each top-level command is read on its own.
  const parts = topLevel(cmd)
  if (parts.length > 1 && parts.some(p => reads(p, depth))) return true
  const payloads = [...shellPayloads(cmd), ...[...cmd.matchAll(EVAL_PAYLOAD)].map(m => (m[1] ?? '').replace(/["'\\]/g, ''))]
  return payloads.some(p => deeper(p, depth))
}
// A payload one layer deeper: read as usual within the bound; past it, denied (nested) unless the regex sees a bypass.
function deeper(payload: string, depth: number): boolean {
  if (!payload.trim()) return false
  if (depth < 3) return reads(payload, depth + 1)
  if (!regexBypass(payload)) nestedTooDeep = true
  return true
}

function reads(cmd: string, depth = 0): boolean {
  tick()
  let { segs, bad } = tokenize(cmd)
  if (bad) {
    const r = inert(cmd)
    if (r?.runs.some(run => (run.deeper ? deeper(run.text, depth) : reads(run.text, depth)))) return true
    if (r) ({ segs, bad } = tokenize(r.text))
    if (bad) return lastResort(cmd, depth)
    segs = segs.map(seg => seg.flatMap(expandWord))
  }
  return segs.some(seg => segmentBypasses(seg, depth))
}
