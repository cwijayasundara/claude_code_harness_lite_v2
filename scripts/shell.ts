// Read-only Bash for scout, reviewer and verifier: a bash- and zsh-faithful word tokenizer and a command allowlist.
// Every check runs on dequoted words, so quotes, escapes and braces cannot hide an option or a second command.
import { parseArgs } from './core.ts'

export type Tokens = { segs: string[][]; bad: string | null }

// After a redirect target or fd: end of input, whitespace or a separator.
const BOUNDARY = /^(?:$|[\s;&|])/

// Splits on unquoted newline ; & | && || into segments of dequoted words. Anything this model does not cover
// exactly (expansions, substitutions, subshells, braces, comments, input and file redirects) is refused in `bad`.
// States: unquoted (\X is X), '...' (no escapes) and "..." (\ escapes only " \ ` $ and newline). $'...' and $"..."
// are refused, so their different escape rules never matter.
export function tokenize(cmd: string): Tokens {
  const segs: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let plain = true // the word so far has no quoted or escaped part, so digits are a redirect fd number
  let q = ''
  const refuse = (bad: string): Tokens => ({ segs: [], bad })
  const flush = (): void => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
    plain = true
  }
  const add = (s: string, quoted: boolean): void => {
    word += s
    inWord = true
    if (quoted) plain = false
  }
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] ?? ''
    const next = cmd[i + 1] ?? ''
    if (q === "'") {
      if (ch === "'") q = ''
      else word += ch
      continue
    }
    if (q === '"') {
      if (ch === '"') q = ''
      else if (ch === '\\' && next === '\n') i++
      else if (ch === '\\' && /["\\`$]/.test(next)) (word += next), i++
      else if (ch === '`' || (ch === '$' && next !== '"')) return refuse('$ expansions and backticks are not allowed (use single quotes)')
      else word += ch
      continue
    }
    if (ch === '\\') {
      if (!next) return refuse('trailing backslash')
      if (next !== '\n') add(next, true)
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      q = ch
      add('', true)
      continue
    }
    if (ch === '`' || (ch === '$' && !BOUNDARY.test(cmd.slice(i + 1)))) return refuse("$ expansions, $'...' and backticks are not allowed")
    if (ch === '(' || ch === ')') return refuse('unquoted ( ) (subshells, substitutions, glob qualifiers) are not allowed; write \\( \\) for find')
    if (ch === '{' || ch === '}') return refuse('unquoted braces are not allowed')
    if (ch === '#' && !inWord) return refuse('comments are not allowed')
    if (ch === '<') return refuse('input redirects, here-docs and process substitution are not allowed')
    if (ch === '>' || (ch === '&' && next === '>')) {
      let j = i + 1
      if (ch === '&') {
        flush()
        j = cmd[i + 2] === '>' ? i + 3 : i + 2
      } else {
        if (inWord && plain && /^\d+$/.test(word)) (word = ''), (inWord = false)
        else flush()
        if (cmd[j] === '>') j++
        else if (cmd[j] === '&') {
          const fd = /^\d+/.exec(cmd.slice(j + 1))?.[0]
          if (!fd || !BOUNDARY.test(cmd.slice(j + 1 + fd.length))) return refuse('output redirects are not allowed (only 2>&1, N>&M and >/dev/null)')
          i = j + fd.length
          continue
        }
      }
      while (cmd[j] === ' ' || cmd[j] === '\t') j++
      if (!cmd.startsWith('/dev/null', j) || !BOUNDARY.test(cmd.slice(j + 9))) return refuse('output redirects are not allowed (only 2>&1, N>&M and >/dev/null)')
      i = j + 8
      continue
    }
    if (ch === ' ' || ch === '\t') flush()
    else if (ch === '\n' || ch === ';' || ch === '&' || ch === '|') {
      flush()
      segs.push(words)
      words = []
      if ((ch === '&' || ch === '|') && next === ch) i++
    } else add(ch, false)
  }
  if (q) return refuse('unterminated quote')
  flush()
  segs.push(words)
  return { segs: segs.filter(s => s.length), bad: null }
}

// True when w is --name or --name=... for an unambiguous prefix of one of names (getopt and git accept prefixes).
const longOpt = (w: string, names: string[]): boolean => {
  const m = /^--([^=]+)/.exec(w)
  return Boolean(m?.[1] && names.some(n => n.startsWith(m[1] ?? '')))
}

const SIMPLE_READERS = new Set(['cat', 'head', 'tail', 'wc', 'grep', 'ls', 'pwd', 'echo', 'printf', 'cut', 'tr', 'diff', 'cmp', 'stat', 'which', 'jq'])
const GIT_READ = new Set(['diff', 'log', 'show', 'status', 'blame', 'grep', 'ls-files', 'rev-parse', 'merge-base', 'describe', 'cat-file'])
const FIND_WRITES = /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/
const RECORDER_READS = new Set(['status', 'check', 'check-file', 'diff', 'skill', 'scope-drift'])
const RECORDER_FLAGS = new Set(['slug', 'json', 'at', 'base', 'expect-fail', 'turn'])
const SED_PRINT = /^(?:\d+|\$|\/[^/]*\/)?(?:,(?:\d+|\$|\/[^/]*\/))?p$/
export const normCmd = (s: string): string => s.trim().replace(/\s+/g, ' ')

function gitAllowed(args: string[]): boolean {
  const w = args[0] === '--no-pager' ? args.slice(1) : args
  const [sub = '', arg = ''] = w
  if (w.some(x => longOpt(x, ['output', 'open-files-in-pager', 'ext-diff']) || /^-[^-]*O/.test(x))) return false
  if (sub === 'branch') return w.slice(1).every(f => /^(?:--show-current|-a|-r|--list|-v|-vv)$/.test(f))
  if (sub === 'stash') return arg === 'list'
  if (sub === 'tag') return /^(?:-l|--list)$/.test(arg)
  return GIT_READ.has(sub)
}

// `node [--disable-warning=X] <path>/sdlc.ts <sub> ...`: reads for everyone; run and verify-report for reviewer and
// verifier, and run only for a command that exactly matches a declared one (sdlc.ts joins the words after --).
function recorderAllowed(w: string[], agent: string, declared: (slug: string | undefined) => Set<string>): string | null {
  const i = w.findIndex(x => !x.startsWith('-'))
  if (i < 0 || !/(?:^|\/)sdlc\.ts$/.test(w[i] ?? '') || w.slice(0, i).some(x => !/^--disable-warning=\S+$/.test(x))) return 'sdlc.ts must be the first thing node runs'
  const sub = w[i + 1] ?? ''
  const rest = w.slice(i + 2)
  const dd = rest.indexOf('--')
  const head = dd < 0 ? rest : rest.slice(0, dd)
  const flags = head.filter(x => x.startsWith('-'))
  const names = flags.map(f => f.replace(/^--/, ''))
  if (new Set(names).size !== names.length) return 'sdlc.ts options may not be repeated'
  const badFlag = flags.find(f => !f.startsWith('--') || !RECORDER_FLAGS.has(f.slice(2)))
  if (badFlag) return `sdlc.ts option ${badFlag} is not allowed`
  if (RECORDER_READS.has(sub)) return null
  if ((sub !== 'run' && sub !== 'verify-report') || /(?:^|:)scout$/.test(agent)) return `sdlc.ts ${sub} is not available to ${agent}`
  if (sub === 'verify-report') return null
  const slug = parseArgs(head).opt.slug
  const cmd = dd < 0 ? '' : rest.slice(dd + 1).join(' ')
  if (/[\r\n]/.test(cmd)) return 'a recorded command must be one line'
  return cmd && declared(typeof slug === 'string' ? slug : undefined).has(normCmd(cmd)) ? null : `${agent} may only run the project's declared verification commands`
}

// Returns why one segment (its dequoted words) is not allowed, or null when it is a known read-only command.
function segmentDenied(w: string[], agent: string, declared: (slug: string | undefined) => Set<string>): string | null {
  const c = w[0] ?? ''
  const args = w.slice(1)
  if (c === 'git') return gitAllowed(args) ? null : 'git is limited to read-only subcommands (diff, log, show, status, ...)'
  if (c === 'node') return recorderAllowed(args, agent, declared)
  if (c === 'find') return args.some(x => FIND_WRITES.test(x)) ? 'find may not delete, write or execute' : null
  if (c === 'rg') return args.some(x => longOpt(x, ['pre', 'hostname-bin'])) ? 'rg --pre and --hostname-bin run commands' : null
  if (c === 'sort') return args.some(x => /^-[^-]*o/.test(x) || longOpt(x, ['output', 'compress-program'])) ? 'sort -o writes a file' : null
  if (c === 'uniq') return args.filter(x => !x.startsWith('-')).length > 1 ? 'uniq with an output file writes' : null
  if (c === 'printf') return args.some(x => /^-v/.test(x)) ? 'printf -v assigns shell variables' : null
  if (c === 'sed') {
    const ok = args[0] === '-n' && SED_PRINT.test(args[1] ?? '') && args.slice(2).every(x => !x.startsWith('-'))
    return ok ? null : 'only sed -n <address>p <files> is read-only'
  }
  if (c === 'awk') {
    if (args.some(x => /^-[a-zA-Z]*[iofledpEW]/.test(x) || longOpt(x, ['include', 'dump-variables', 'profile', 'file', 'source', 'load', 'exec', 'pretty-print']))) return 'awk may not write files or load programs'
    return args.some(x => /[>|@]|system\s*\(|getline/.test(x)) ? 'awk programs may not write, load or run commands' : null
  }
  return SIMPLE_READERS.has(c) ? null : `${c || 'this command'} is not on the read-only allowlist`
}

// Why a read-only agent may not run cmd, or null when every segment is an allowlisted read-only command.
export function readOnlyDenial(cmd: string, agent: string, declared: (slug: string | undefined) => Set<string>): string | null {
  const { segs, bad } = tokenize(cmd)
  if (bad) return bad
  for (const w of segs) {
    const why = segmentDenied(w, agent, declared)
    if (why) return `"${w.join(' ').slice(0, 60)}": ${why}`
  }
  return null
}
