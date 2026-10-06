// The git-hook bypass guard for pre-bash: whether a Bash command switches the rig git hooks off. Best effort; CI is
// the floor. It reads dequoted words from the shell.ts tokenizer, so quotes and escapes cannot hide a flag.
import { tokenize } from './shell.ts'

// The model may not switch the git hooks off (only the person does): --no-verify on commit or push (any prefix),
// -n on commit, core.hooksPath in any spelling or scope, an alias that adds either, or rig's own uninstall / install --force.
// Read on dequoted words; a command tokenize refuses ($(...), redirects, braces) falls back to a regex.
const RIG_HOOKS_OFF = /sdlc\.(?:m?js|ts)\b[^;&|\n]*\bhooks\s+(?:uninstall\b|install\b[^;&|\n]*--force)/
const NO_VERIFY_FLAGS = /\bgit\b[^;&|\n]*\bcommit\b[^;&|\n]*(?:--no-v\w*|\s-[a-zA-Z]*n[a-zA-Z]*(?=\s|$))|\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*--no-v\w*/i
const NO_VERIFY_CONFIG = /\bgit\b[^;&|\n]*core\.hookspath/i
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
    return bypassesGitHooks(value.startsWith('!') ? value.slice(1) : `git ${value}`, depth + 1)
  })
}

const SHELLS = /^(?:sh|bash|zsh|dash|ksh)$/i
// A program's name as a case-insensitive filesystem (macOS, Windows) finds it: GIT, /usr/bin/Git and git.exe run git.
const progName = (w: string): string => (w.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')
// The fallback for text the tokenizer refuses: quoted strings not starting with - are blanked for the flags (a message
// that mentions --no-verify is fine), and core.hooksPath must share a line with git.
function regexBypass(text: string): boolean {
  const flags = text.replace(/"([^"]*)"|'([^']*)'/g, (_m, a?: string, b?: string) => ((a ?? b ?? '').startsWith('-') ? ` ${a ?? b} ` : '""'))
  const plain = text.replace(/["'\\]/g, '')
  return NO_VERIFY_FLAGS.test(flags) || NO_VERIFY_CONFIG.test(plain) || RIG_HOOKS_OFF.test(plain)
}
// A git command at the start of one word (an argument of another program, e.g. watch 'git ...') gets the regex.
const embeddedGit = (words: string[]): boolean => words.some(w => /^\s*git(?:\.exe)?\s/i.test(w) && regexBypass(w))

// Programs that run their first operand as the command, with the options that take a separate value.
const WRAPPERS = new Map<string, string[]>([
  ['env', ['-u', '-C', '-S', '--unset', '--chdir', '--split-string']],
  ['sudo', ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '-R', '--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type', '--other-user']],
  ['xargs', ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--arg-file', '--delimiter']],
  ['timeout', ['-s', '-k', '--signal', '--kill-after']], ['nice', ['-n', '--adjustment']], ['exec', ['-a']],
  ['nohup', []], ['time', []], ['command', []], ['builtin', []],
])
const SHELL_VALUE = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])

// Where the program a segment really runs stands: past assignments and the wrappers above with their options.
function programAt(seg: string[]): number {
  let k = 0
  for (;;) {
    while (/^\w+=/.test(seg[k] ?? '')) k++
    const name = progName(seg[k] ?? '')
    const takes = WRAPPERS.get(name)
    if (!takes) return k
    k++
    while ((seg[k] ?? '').startsWith('-')) {
      const o = seg[k++] ?? ''
      if (o === '--') break
      if (takes.includes(o)) k++
    }
    if (name === 'timeout') k++ // the duration
  }
}

// The words a segment runs as a command of its own, as [from, to): the word after the -c cluster (and an optional --)
// of a shell that is the program really run (so env, sudo -u x, xargs, nohup, timeout N, nice or time cannot hide it,
// and a word named sh among git's arguments is not one), or the words after eval (behind command or builtin).
function payloadSpan(seg: string[]): [number, number] | null {
  const k = programAt(seg)
  const w = seg[k] ?? ''
  if (w === 'eval') return [k + 1, seg.length]
  if (!SHELLS.test(progName(w))) return null
  for (let i = k + 1; i < seg.length && /^[-+]./.test(seg[i] ?? '') && seg[i] !== '--'; i++) {
    if (SHELL_VALUE.has(seg[i] ?? '')) i++
    else if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(seg[i] ?? '')) {
      const p = seg[i + 1] === '--' ? i + 2 : i + 1
      return p < seg.length ? [p, p + 1] : null
    }
  }
  return null
}

function segmentBypasses(seg: string[], depth: number): boolean {
  // A payload is read the same way, bounded; past the bound it is denied (nested), never passed unread.
  const span = payloadSpan(seg)
  const payload = span ? seg.slice(...span).join(' ') : ''
  if (deeper(payload, depth)) return true
  // The whole segment is read as usual too (never masked); only the embedded-git heuristic skips the payload words,
  // which were just read exactly.
  const skip = new Set(span ? seg.slice(...span) : [])
  const embedded = (words: string[]): boolean => embeddedGit(words.filter(w => !skip.has(w)))
  const s = seg.findIndex(w => /sdlc\.(?:m?js|ts)$/.test(w))
  const h = seg.indexOf('hooks', s + 1)
  if (s >= 0 && h > s && (seg[h + 1] === 'uninstall' || (seg[h + 1] === 'install' && seg.includes('--force')))) return true
  const g = seg.findIndex(w => progName(w) === 'git')
  if (g < 0) return seg.some(w => /^\w+=/.test(w) && HOOKS_PATH.test(w)) || embedded(seg)
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

let nestedTooDeep = false
// Why the model may not run cmd: 'bypass', 'nested' (shells or evals more than three deep), or null.
export function gitHooksBypass(cmd: string): 'bypass' | 'nested' | null {
  nestedTooDeep = false
  return bypassesGitHooks(cmd) ? (nestedTooDeep ? 'nested' : 'bypass') : null
}

// For the guard only: what tokenize refuses but leaves a command readable is swapped for an inert word (_) or removed,
// and the commands it runs are returned to be read too. $(...), backticks and <(...) >(...) become _ and their bodies
// are run; $NAME, ${...} and $1 $@ $? ... become _; redirects go with their target; comments go; ( ) and standalone
// { } become separators; here-doc bodies are data and go, unless a shell or eval reads them (then they are run, one
// layer deeper, like a here-string). Null when the text cannot be followed (the caller then uses the regex).
type Run = { text: string; deeper: boolean }
type Inert = { text: string; runs: Run[]; end: number }
const READS_SCRIPT = /(?:^|[\s/])(?:sh|bash|zsh|dash|ksh|eval)(?:\.exe)?(?:\s|$)/i
const unquote = (w: string): string => w.replace(/'([^']*)'|"((?:[^"\\]|\\[^])*)"|\\([^])/g,
  (_m, a?: string, b?: string, c?: string) => a ?? (b === undefined ? c ?? '' : b.replace(/\\(["\\$`\n])/g, '$1')))
function inert(src: string, start = 0, close = ''): Inert | null {
  let out = ''
  let q = ''
  let parens = 0
  const runs: Run[] = []
  const docs: { delim: string; tabs: boolean; run: boolean }[] = []
  const shellHere = (): boolean => READS_SCRIPT.test(out.split(/[;&|\n]/).pop() ?? '')
  const wordEnd = (i: number): number => { // end of the shell word at i; -1 when it is empty, unterminated or substitutes
    const from = i
    let wq = ''
    for (; i < src.length; i++) {
      const c = src[i] ?? ''
      if (wq === "'") { if (c === "'") wq = ''; continue }
      if (c === '\\') { i++; continue }
      if (c === '`' || (c === '$' && src[i + 1] === '(')) return -1
      if (wq) { if (c === '"') wq = ''; continue }
      if (c === "'" || c === '"') wq = c
      else if (/[\s;&|<>()]/.test(c)) break
    }
    return wq || i === from ? -1 : i
  }
  for (let i = start; i < src.length; i++) {
    const ch = src[i] ?? ''
    const next = src[i + 1] ?? ''
    if (q === "'") { out += ch; if (ch === "'") q = ''; continue }
    if (ch === '\\') { out += ch + next; i++; continue }
    if (q === '"' && ch === '"') { out += ch; q = ''; continue }
    if ((ch === '$' || (!q && (ch === '<' || ch === '>'))) && next === '(') {
      const r = inert(src, i + 2, ')')
      if (!r) return null
      runs.push({ text: src.slice(i + 2, r.end), deeper: false })
      out += '_'
      i = r.end
      continue
    }
    if (ch === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1
      if (j >= src.length) return null
      runs.push({ text: src.slice(i + 1, j).replace(/\\([`\\$])/g, '$1'), deeper: false })
      out += '_'
      i = j
      continue
    }
    if (ch === '$' && next === '{') {
      const j = src.indexOf('}', i)
      if (j < 0 || /\$\(|`/.test(src.slice(i, j))) return null
      out += '_'
      i = j
      continue
    }
    if (ch === '$' && /[\w@*#?$!-]/.test(next)) {
      i += /[A-Za-z_]/.test(next) ? (/^\w+/.exec(src.slice(i + 1))?.[0].length ?? 1) : 1
      out += '_'
      continue
    }
    if (q === '"') { out += ch; continue }
    if (ch === "'" || ch === '"') { q = ch; out += ch; continue }
    if (ch === '#' && /(?:^|[\s;&|()])$/.test(out)) {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++
      continue
    }
    if (ch === '<' && next === '<') {
      const here = src[i + 2] === '<'
      const tabs = !here && src[i + 2] === '-'
      let j = i + (here || tabs ? 3 : 2)
      while (src[j] === ' ' || src[j] === '\t') j++
      const e = wordEnd(j)
      if (e < 0) return null
      if (here && shellHere()) runs.push({ text: unquote(src.slice(j, e)), deeper: true })
      if (!here) docs.push({ delim: unquote(src.slice(j, e)), tabs, run: shellHere() })
      out += ' '
      i = e - 1
      continue
    }
    if (ch === '<' || ch === '>' || (ch === '&' && next === '>')) {
      out = out.replace(/(^|[\s;&|()])\d+$/, '$1') // an fd number before the operator
      let j = ch === '&' ? i + 2 : i + 1
      if (src[j] === '>' || (ch === '>' && src[j] === '|')) j++
      else if (ch !== '&' && src[j] === '&') {
        const fd = /^(?:\d+|-)(?=$|[\s;&|)])/.exec(src.slice(j + 1))?.[0]
        if (fd) { out += ' '; i = j + fd.length; continue }
        j++
      }
      while (src[j] === ' ' || src[j] === '\t') j++
      const e = wordEnd(j)
      if (e < 0) return null
      out += ' '
      i = e - 1
      continue
    }
    if (ch === '\n' && docs.length) {
      let j = i + 1
      for (const d of docs) {
        const from = j
        let body = ''
        for (;;) {
          const nl = src.indexOf('\n', j)
          const line = src.slice(j, nl < 0 ? src.length : nl)
          const ends = (d.tabs ? line.replace(/^\t+/, '') : line) === d.delim
          if (ends || nl < 0) {
            body = ends ? src.slice(from, j) : src.slice(from)
            j = nl < 0 ? src.length : nl + 1
            break
          }
          j = nl + 1
        }
        if (d.run) runs.push({ text: body, deeper: true })
      }
      docs.length = 0
      out += '\n'
      i = j - 1
      continue
    }
    if (ch === '(') { parens++; out += ' ; '; continue }
    if (ch === ')') {
      if (close && parens === 0) return { text: out, runs, end: i }
      if (--parens < 0) return null
      out += ' ; '
      continue
    }
    if ((ch === '{' || ch === '}') && /(?:^|[\s;&|])$/.test(out) && /^(?:$|[\s;&|])/.test(next)) { out += ' ; '; continue }
    out += ch
  }
  return q || close || docs.length ? null : { text: out, runs, end: src.length }
}

// The last resort, for text even inert() cannot follow: the regex, and the words a shell -c or eval runs, unquoted
// and read again one layer deeper (past the bound: denied).
const SHELL_PAYLOAD = /(?:^|[\s;&|(`/])(?:sh|bash|zsh|dash|ksh)(?:\.exe)?\s+(?:[-+]\S*\s+)*?-[a-zA-Z]*c[a-zA-Z]*\s+(?:--\s+)?((?:'[^']*'|"(?:[^"\\]|\\[^])*"|\\[^]|[^\s;&|'"\\])+)/gi
const EVAL_PAYLOAD = /(?:^|[\s;&|(`])eval\s+([^;&|\n]+)/g
function lastResort(cmd: string, depth: number): boolean {
  if (regexBypass(cmd)) return true
  const payloads = [...[...cmd.matchAll(SHELL_PAYLOAD)].map(m => unquote(m[1] ?? '')), ...[...cmd.matchAll(EVAL_PAYLOAD)].map(m => (m[1] ?? '').replace(/["'\\]/g, ''))]
  return payloads.some(p => deeper(p, depth))
}
// A payload one layer deeper: read as usual within the bound; past it, denied (nested) unless the regex sees a bypass.
function deeper(payload: string, depth: number): boolean {
  if (!payload.trim()) return false
  if (depth < 3) return bypassesGitHooks(payload, depth + 1)
  if (!regexBypass(payload)) nestedTooDeep = true
  return true
}

export function bypassesGitHooks(cmd: string, depth = 0): boolean {
  let { segs, bad } = tokenize(cmd)
  if (bad) {
    const r = inert(cmd)
    if (r?.runs.some(run => (run.deeper ? deeper(run.text, depth) : bypassesGitHooks(run.text, depth)))) return true
    if (r) ({ segs, bad } = tokenize(r.text))
    if (bad) return lastResort(cmd, depth)
  }
  return segs.some(seg => segmentBypasses(seg, depth))
}
