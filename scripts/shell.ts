// Read-only Bash for scout, reviewer and verifier: a bash- and zsh-faithful word tokenizer and a command allowlist.
// Every check runs on dequoted words, so quotes, escapes and braces cannot hide an option or a second command.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs, ROOT, PLUGIN_ROOT } from './core.ts'

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

// Only the harness's own script counts as sdlc.ts: the plugin's copy or the project's vendored one, by real path
// (a file that does not exist, a look-alike named sdlc.ts, or a symlink to one is refused).
export const atRoot = (cwd?: string): boolean => {
  try { return !cwd || fs.realpathSync(cwd) === fs.realpathSync(ROOT) } catch { return false }
}
export function isHarnessScript(token: string, cwd?: string): boolean {
  if (!atRoot(cwd)) return false
  try {
    const real = fs.realpathSync(path.resolve(ROOT, token))
    return [path.join(PLUGIN_ROOT, 'scripts', 'sdlc.ts'), path.join(ROOT, '.sdlc', 'bin', 'sdlc.ts')]
      .some(p => { try { return fs.realpathSync(p) === real } catch { return false } })
  } catch { return false }
}

// `node [--disable-warning=X] <path>/sdlc.ts <sub> ...`: reads for everyone; run and verify-report for reviewer and
// verifier, and run only for a command that exactly matches a declared one (sdlc.ts joins the words after --).
function recorderAllowed(w: string[], agent: string, declared: (slug: string | undefined) => Set<string>, cwd?: string): string | null {
  const i = w.findIndex(x => !x.startsWith('-'))
  if (i < 0 || !isHarnessScript(w[i] ?? '', cwd) || w.slice(0, i).some(x => !/^--disable-warning=\S+$/.test(x))) return 'sdlc.ts must be the first thing node runs'
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
function segmentDenied(w: string[], agent: string, declared: (slug: string | undefined) => Set<string>, cwd?: string): string | null {
  const c = w[0] ?? ''
  const args = w.slice(1)
  if (c === 'git') return gitAllowed(args) ? null : 'git is limited to read-only subcommands (diff, log, show, status, ...)'
  if (c === 'node') return recorderAllowed(args, agent, declared, cwd)
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
// Credential files a read-only agent has no reason to open; the settings Read() deny does not cover Bash.
const SECRET_FILE = /(?:^|[\\/])(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|credentials|[^\\/]*\.(?:pem|key|p12|pfx))$|[\\/]\.(?:aws|ssh|gnupg)[\\/]/
// A glob can name a credential file without spelling it (.en*): match it against well-known names.
const SECRET_NAMES = ['.env', '.env.local', '.env.production', '.netrc', '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519', 'credentials', 'server.pem', 'server.key']
const globHitsSecret = (t: string): boolean => {
  if (!/[*?[]/.test(t)) return false
  const base = t.slice(t.lastIndexOf('/') + 1)
  let re: RegExp
  try { re = new RegExp('^' + base.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') } catch { return true }
  return SECRET_NAMES.some(n => re.test(n))
}
// grep -r reads dotfiles (.env); the Grep tool honours ignore rules, and so does rg unless --hidden or -u.
const sweepsSecrets = (c: string, args: string[]): boolean =>
  (c === 'grep' && args.some(x => /^-[a-zA-Z]*[rR]/.test(x) || longOpt(x, ['recursive', 'dereference-recursive']))) ||
  (c === 'rg' && args.some(x => /^-[a-zA-Z]*u/.test(x) || longOpt(x, ['hidden', 'no-ignore', 'unrestricted'])))
export function readOnlyDenial(cmd: string, agent: string, declared: (slug: string | undefined) => Set<string>, cwd?: string): string | null {
  const { segs, bad } = tokenize(cmd)
  if (bad) return bad
  for (const w of segs) {
    if (w.some(t => SECRET_FILE.test(t) || globHitsSecret(t)) || sweepsSecrets(w[0] ?? '', w.slice(1))) return `"${w.join(' ').slice(0, 60)}": credential files are off limits to read-only agents (use the Read or Grep tool; a glob, grep -r or rg --hidden can reach them too)`
    const why = segmentDenied(w, agent, declared, cwd)
    if (why) return `"${w.join(' ').slice(0, 60)}": ${why}`
  }
  return null
}

// The model may not switch the git hooks off (only the person does): --no-verify on commit or push (any prefix),
// -n on commit, core.hooksPath in any spelling or scope, an alias that adds either, or rig's own uninstall / install --force.
// Read on dequoted words; a command tokenize refuses ($(...), redirects, braces) falls back to a regex.
const RIG_HOOKS_OFF = /sdlc\.(?:m?js|ts)\b[^;&|\n]*\bhooks\s+(?:uninstall\b|install\b[^;&|\n]*--force)/
const REGEX_BYPASS = [/\bgit\b[^;&|\n]*\bcommit\b[^;&|\n]*(?:--no-v\w*|\s-[a-zA-Z]*n[a-zA-Z]*(?=\s|$))|\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*--no-v\w*/i, /core\.hookspath/i, RIG_HOOKS_OFF]
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

function aliasBypass(words: string[]): boolean {
  return words.some((w, i) => {
    const m = /^alias\.[^=]*(?:=([^]*))?$/i.exec(w)
    if (!m) return false
    const value = m[1] ?? words[i + 1] ?? ''
    return bypassesGitHooks(value.startsWith('!') ? value.slice(1) : `git ${value}`)
  })
}

function segmentBypasses(seg: string[]): boolean {
  const s = seg.findIndex(w => /sdlc\.(?:m?js|ts)$/.test(w))
  const h = seg.indexOf('hooks', s + 1)
  if (s >= 0 && h > s && (seg[h + 1] === 'uninstall' || (seg[h + 1] === 'install' && seg.includes('--force')))) return true
  const g = seg.findIndex(w => w === 'git' || w.endsWith('/git'))
  if (g < 0) return seg.some(w => /^\w+=/.test(w) && HOOKS_PATH.test(w))
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
  return scanned.some(w => HOOKS_PATH.test(w)) || aliasBypass(scanned)
}

export function bypassesGitHooks(cmd: string): boolean {
  const { segs, bad } = tokenize(cmd)
  if (bad) return REGEX_BYPASS.some(re => re.test(cmd.replace(/["'\\]/g, '')))
  return segs.some(segmentBypasses)
}
