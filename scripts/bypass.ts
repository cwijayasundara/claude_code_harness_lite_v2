// The git-hook bypass guard for pre-bash: whether a Bash command switches the rig git hooks off. Best effort; CI is
// the floor. It reads dequoted words from the shell.ts tokenizer, so quotes and escapes cannot hide a flag.
import { tokenize } from './shell.ts'

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

const SHELLS = /^(?:sh|bash|zsh|dash|ksh)$/i
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
// Wrapper options whose value is a whole command line (env -S), read as a payload.
const LINE_VALUE = new Set(['-S', '--split-string'])
const SHELL_VALUE = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])

// Where the program a segment really runs stands, past assignments and the wrappers above with their options; and
// the wrapper option values that are command lines of their own.
function programAt(seg: string[]): { k: number; lines: number[] } {
  let k = 0
  const lines: number[] = []
  for (;;) {
    while (/^\w+=/.test(seg[k] ?? '')) k++
    const name = progName(seg[k] ?? '')
    const takes = WRAPPERS.get(name)
    if (!takes) return { k, lines }
    k++
    while ((seg[k] ?? '').startsWith('-')) {
      const o = seg[k++] ?? ''
      if (o === '--') break
      if (LINE_VALUE.has(o) && name === 'env') lines.push(k)
      if (takes.includes(o)) k++
    }
    if (name === 'timeout' || name === 'chroot') k++ // the duration, the new root
  }
}

// The words a segment runs as a command of its own, as [from, to): the word after the -c cluster (and an optional --)
// of a shell that is the program really run (so env, sudo -u x, xargs, nohup, timeout N, nice or time cannot hide it,
// and a word named sh among git's arguments is not one); su's -c value; env -S's value; or the words after eval
// (behind command or builtin).
function payloadSpans(seg: string[]): [number, number][] {
  const { k, lines } = programAt(seg)
  const spans = lines.filter(i => i < seg.length).map((i): [number, number] => [i, i + 1])
  const w = seg[k] ?? ''
  const one = (p: number): void => { if (p < seg.length) spans.push([p, p + 1]) }
  if (w === 'eval') spans.push([k + 1, seg.length])
  else if (progName(w) === 'su') {
    const c = seg.findIndex((x, i) => i > k && (x === '-c' || x === '--command'))
    if (c > 0) one(c + 1)
  } else if (SHELLS.test(progName(w))) {
    for (let i = k + 1; i < seg.length && /^[-+]./.test(seg[i] ?? '') && seg[i] !== '--'; i++) {
      if (SHELL_VALUE.has(seg[i] ?? '')) i++
      else if (/^-[a-zA-Z]+$/.test(seg[i] ?? '') && (seg[i] ?? '').includes('c')) {
        one(seg[i + 1] === '--' ? i + 2 : i + 1)
        break
      }
    }
  }
  return spans
}

function segmentBypasses(seg: string[], depth: number): boolean {
  tick()
  // A payload is read the same way, bounded; past the bound it is denied (nested), never passed unread.
  const spans = payloadSpans(seg)
  if (spans.some(span => deeper(seg.slice(...span).join(' '), depth))) return true
  // The whole segment is read as usual too (never masked); only the embedded-git heuristic skips the payload words,
  // which were just read exactly.
  const skip = new Set(spans.flatMap(span => seg.slice(...span)))
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

// Limits, each failing closed (the command is denied as 'limit', never passed): a command over MAX_COMMAND characters;
// more than BUDGET_MS of work (checked as it goes, and again at the end); more than MAX_WORDS words or MAX_EXPANDED
// characters from brace expansion; and anything that throws, such as nesting deeper than the stack. The depth bound for shells and evals is 'nested' (also denied).
const MAX_COMMAND = 128 * 1024
const BUDGET_MS = 100
const MAX_WORDS = 4096
const MAX_EXPANDED = 1 << 20 // characters brace expansion may produce
let deadline = Infinity
let braceWords = 0
let braceChars = 0
let clock = (): number => performance.now()
const tick = (): void => { if (clock() >= deadline) throw new Error('out of time') }

let nestedTooDeep = false
// Why the model may not run cmd: 'bypass', 'nested' (shells or evals more than three deep), 'limit' (too large, deep or
// slow to read), or null.
// budgetMs and now are for tests; a scan that ends past the deadline (a step tick() could not interrupt) is denied too.
export function gitHooksBypass(cmd: string, budgetMs = BUDGET_MS, now = (): number => performance.now()): 'bypass' | 'nested' | 'limit' | null {
  nestedTooDeep = false
  braceWords = 0
  braceChars = 0
  if (cmd.length > MAX_COMMAND) return 'limit'
  clock = now
  deadline = clock() + budgetMs
  try {
    const bypass = reads(cmd)
    if (clock() >= deadline) return 'limit'
    return bypass ? (nestedTooDeep ? 'nested' : 'bypass') : null
  } catch {
    return 'limit'
  } finally {
    deadline = Infinity
    clock = () => performance.now()
  }
}
export const bypassesGitHooks = (cmd: string): boolean => gitHooksBypass(cmd) !== null

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
// $'...' as bash decodes it (\xHH, \uHHHH, octal, \n \t ..., \c), so a flag spelled with escapes is still seen.
const ANSI = new Map(Object.entries({ n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' }))
const ansiC = (body: string): string => body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c[^]|[^])/g, (_m, e: string) => {
  const c = e[0] ?? ''
  if ('xuU'.includes(c)) return String.fromCodePoint(Math.min(parseInt(e.slice(1), 16), 0x10ffff))
  if (/[0-7]/.test(c)) return String.fromCharCode(parseInt(e, 8) & 255)
  if (c === 'c') return String.fromCharCode(e.charCodeAt(1) & 31)
  return `\\'"?`.includes(c) ? c : ANSI.get(c) ?? `\\${e}`
})
// Brace expansion: inert() marks an unquoted { , } with these, and each word is expanded after tokenize (a{b,c} is
// ab ac; a brace with no comma, as in {} or @{u}, stays literal).
const [BO, BC, BE] = ['\u0001', '\u0002', '\u0003']
const literal = (w: string): string => w.replaceAll(BO, '{').replaceAll(BC, ',').replaceAll(BE, '}')
// One linear pass first: a brace with no comma of its own, or with no partner, is literal, so only real groups recurse.
function realGroups(w: string): string {
  const chars = w.split('')
  const open: { at: number; comma: boolean }[] = []
  chars.forEach((c, i) => {
    if (c === BO) open.push({ at: i, comma: false })
    else if (c === BC) { const top = open.at(-1); if (top) top.comma = true; else chars[i] = ',' }
    else if (c === BE) {
      const top = open.pop()
      if (!top || !top.comma) (chars[i] = '}'), top && (chars[top.at] = '{')
    }
  })
  for (const o of open) chars[o.at] = '{'
  return chars.join('')
}
function expandBraces(w: string): string[] {
  tick()
  const open = w.indexOf(BO)
  if (open < 0) {
    braceChars += w.length
    if (++braceWords > MAX_WORDS || braceChars > MAX_EXPANDED) throw new Error('too many words')
    return [literal(w)]
  }
  const cuts: number[] = []
  for (let i = open, depth = 0; i < w.length; i++) {
    if (w[i] === BO) depth++
    else if (w[i] === BC && depth === 1) cuts.push(i)
    else if (w[i] === BE && --depth === 0) {
      const head = w.slice(0, open)
      const tail = w.slice(i + 1)
      const words = [open, ...cuts].flatMap((c, j) => expandBraces(head + w.slice(c + 1, cuts[j] ?? i) + tail))
      return words
    }
  }
  return [literal(w)]
}

function inert(src: string, start = 0, close = ''): Inert | null {
  const buf: string[] = [] // the output, in chunks; last is its last character (reading a growing string is quadratic)
  let last = ''
  const put = (t: string): void => { if (t) (buf.push(t), (last = t.at(-1) ?? '')) }
  let q = ''
  let parens = 0
  let braces = 0
  const runs: Run[] = []
  const docs: { delim: string; tabs: boolean; run: boolean }[] = []
  const shellHere = (): boolean => { // a shell or eval earlier in the current command
    let j = buf.length
    while (j > 0 && !/[;&|\n]/.test(buf[j - 1] ?? '')) j--
    const head = buf[j - 1] ?? ''
    return READS_SCRIPT.test(head.slice(Math.max(...[';', '&', '|', '\n'].map(c => head.lastIndexOf(c))) + 1) + buf.slice(j).join(''))
  }
  const endsIn = (set: string): boolean => last === '' || set.includes(last)
  const wordEnd = (i: number): number => { // end of the shell word at i (its substitutions are run); -1 when empty or unterminated
    const from = i
    let wq = ''
    for (; i < src.length; i++) {
      const c = src[i] ?? ''
      if (wq === "'") { if (c === "'") wq = ''; continue }
      if (c === '\\') { i++; continue }
      if (c === '$' && src[i + 1] === '(') {
        const r = inert(src, i + 2, ')')
        if (!r) return -1
        runs.push({ text: src.slice(i + 2, r.end), deeper: false })
        i = r.end
        continue
      }
      if (c === '`') {
        const j = src.indexOf('`', i + 1)
        if (j < 0) return -1
        runs.push({ text: src.slice(i + 1, j), deeper: false })
        i = j
        continue
      }
      if (wq) { if (c === '"') wq = ''; continue }
      if (c === "'" || c === '"') wq = c
      else if (/[\s;&|<>()]/.test(c)) break
    }
    return wq || i === from ? -1 : i
  }
  for (let i = start; i < src.length; i++) {
    if ((i & 1023) === 0) tick()
    const ch = src[i] ?? ''
    const next = src[i + 1] ?? ''
    if (q === "'") { put(ch); if (ch === "'") q = ''; continue }
    if (ch === '\\') { put(ch + next); i++; continue }
    if (q === '"' && ch === '"') { put(ch); q = ''; continue }
    if ((ch === '$' || (!q && (ch === '<' || ch === '>'))) && next === '(') {
      const r = inert(src, i + 2, ')')
      if (!r) return null
      runs.push({ text: src.slice(i + 2, r.end), deeper: false })
      put('_')
      i = r.end
      continue
    }
    if (ch === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1
      if (j >= src.length) return null
      runs.push({ text: src.slice(i + 1, j).replace(/\\([`\\$])/g, '$1'), deeper: false })
      put('_')
      i = j
      continue
    }
    if (ch === '$' && next === '{') {
      const j = src.indexOf('}', i)
      if (j < 0 || /\$\(|`/.test(src.slice(i, j))) return null
      put('_')
      i = j
      continue
    }
    if (ch === '$' && /[\w@*#?$!-]/.test(next)) {
      i += /[A-Za-z_]/.test(next) ? (/^\w+/.exec(src.slice(i + 1))?.[0].length ?? 1) : 1
      put('_')
      continue
    }
    if (q === '"') { put(ch); continue }
    if (ch === '$' && next === "'") {
      let j = i + 2
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1
      if (j >= src.length) return null
      put(`'${ansiC(src.slice(i + 2, j)).replaceAll("'", `'\\''`)}'`)
      i = j
      continue
    }
    if (ch === '$' && next === '"') continue // a locale string: the quotes that follow are read as usual
    if (ch === "'" || ch === '"') { q = ch; put(ch); continue }
    if (ch === '#' && endsIn(' \t\n;&|()')) {
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
      put(' ')
      i = e - 1
      continue
    }
    if (ch === '<' || ch === '>' || (ch === '&' && next === '>')) {
      let d = buf.length // an fd number before it (digits arrive one per chunk) goes with it
      while (d > 0 && /^\d$/.test(buf[d - 1] ?? '')) d--
      if (d < buf.length && (d === 0 || ' \t\n;&|()'.includes((buf[d - 1] ?? '').at(-1) ?? ''))) {
        buf.length = d
        last = buf[d - 1]?.at(-1) ?? ''
      }
      let j = ch === '&' ? i + 2 : i + 1
      if (src[j] === '>' || (ch === '>' && src[j] === '|')) j++
      else if (ch !== '&' && src[j] === '&') {
        const fd = /^(?:\d+|-)(?=$|[\s;&|)])/.exec(src.slice(j + 1))?.[0]
        if (fd) { put(' '); i = j + fd.length; continue }
        j++
      }
      while (src[j] === ' ' || src[j] === '\t') j++
      const e = wordEnd(j)
      if (e < 0) return null
      put(' ')
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
      put('\n')
      i = j - 1
      continue
    }
    if (ch === '(') { parens++; put(' ; '); continue }
    if (ch === ')') {
      if (close && parens === 0) return { text: buf.join(''), runs, end: i }
      if (--parens < 0) return null
      put(' ; ')
      continue
    }
    if ((ch === '{' || ch === '}') && endsIn(' \t\n;&|') && (next === '' || ' \t\n;&|'.includes(next))) { put(' ; '); continue }
    if (ch === '{') { braces++; put(BO); continue }
    if (ch === ',' && braces > 0) { put(BC); continue }
    if (ch === '}' && braces > 0) { braces--; put(BE); continue }
    if (/[\s;&|]/.test(ch)) braces = 0
    put(ch)
  }
  return q || close ? null : { text: buf.join(''), runs, end: src.length } // a here-doc left open runs to the end, as in bash
}

// The last resort, for text even inert() cannot follow: the regex, and the words a shell -c or eval runs, unquoted
// and read again one layer deeper (past the bound: denied).
// Linear by construction: the shell word is found once, then its words are read one at a time (no nested quantifiers).
const SHELL_AT = /(?:^|[\s;&|(`/])(?:sh|bash|zsh|dash|ksh)(?:\.exe)?(?=\s)/gi
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
// The top-level commands of text, split on unquoted ; & | and newlines outside parentheses.
function topLevel(cmd: string): string[] {
  const parts: string[] = []
  let q = ''
  let depth = 0
  let from = 0
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] ?? ''
    if (q === "'") { if (c === "'") q = ''; continue }
    if (c === '\\') { i++; continue }
    if (q === '"') { if (c === '"') q = ''; continue }
    if (c === '$' && cmd[i + 1] === "'") { for (i += 2; i < cmd.length && cmd[i] !== "'"; i++) if (cmd[i] === '\\') i++; continue }
    if (c === "'" || c === '"') q = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0 && /[;&|\n]/.test(c)) (parts.push(cmd.slice(from, i)), (from = i + 1))
  }
  parts.push(cmd.slice(from))
  return parts.filter(p => p.trim())
}
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
    segs = segs.map(seg => seg.flatMap(w => (w.includes(BO) ? expandBraces(realGroups(w)) : [literal(w)])))
  }
  return segs.some(seg => segmentBypasses(seg, depth))
}
