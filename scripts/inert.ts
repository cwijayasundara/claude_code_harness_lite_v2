// The guard's reader for text the shell.ts tokenizer refuses: inert() makes it readable, and the budget that bounds the
// whole guard (bypass.ts) lives here so the reader can check it as it goes. Every limit fails closed: tick() throws.
export const SHELL_NAMES = 'sh|bash|zsh|dash|ksh|ash|mksh|csh|tcsh|fish'

const MAX_WORDS = 4096 // words brace expansion may produce
const MAX_EXPANDED = 1 << 20 // characters brace expansion may produce
let deadline = Infinity
let braceWords = 0
let braceChars = 0
let clock = (): number => performance.now()
export const tick = (): void => { if (clock() >= deadline) throw new Error('out of time') }
export function startBudget(ms: number, now: () => number): void {
  clock = now
  deadline = clock() + ms
  braceWords = 0
  braceChars = 0
}
export const overBudget = (): boolean => clock() >= deadline
export function endBudget(): void {
  deadline = Infinity
  clock = () => performance.now()
}

// For the guard only: what tokenize refuses but leaves a command readable is swapped for an inert word (_) or removed,
// and the commands it runs are returned to be read too. $(...), backticks and <(...) >(...) become _ and their bodies
// are run; $NAME, ${...} and $1 $@ $? ... become _; redirects go with their target; comments go; ( ) and standalone
// { } become separators; here-doc bodies are data and go, unless a shell or eval reads them (then they are run, one
// layer deeper, like a here-string). Null when the text cannot be followed (the caller then uses the regex).
export type Run = { text: string; deeper: boolean }
type Inert = { text: string; runs: Run[]; end: number }
const READS_SCRIPT = new RegExp(`(?:^|[\\s/])(?:${SHELL_NAMES}|eval)(?:\\.exe)?(?:\\s|$)`, 'i')
export const unquote = (w: string): string => w.replace(/'([^']*)'|"((?:[^"\\]|\\[^])*)"|\\([^])/g,
  (_m, a?: string, b?: string, c?: string) => a ?? (b === undefined ? c ?? '' : b.replace(/\\(["\\$`\n])/g, '$1')))
// $'...' as bash decodes it (\xHH, \uHHHH, octal, \n \t ..., \c), so a flag spelled with escapes is still seen.
const ANSI = new Map(Object.entries({ n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' }))
const ansiC = (body: string): string => body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c[^]|[^])/g, (_m, e: string) => {
  const c = e[0] ?? ''
  if ('xuU'.includes(c) && e.length === 1) return `\\${e}` // no hex digits: bash keeps it as written
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

export function inert(src: string, start = 0, close = ''): Inert | null {
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

// The top-level commands of text, split on unquoted ; & | and newlines outside parentheses.
export function topLevel(cmd: string): string[] {
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
// A word as bash expands its braces (only words inert() marked have any).
export const expandWord = (w: string): string[] => (w.includes(BO) ? expandBraces(realGroups(w)) : [literal(w)])
