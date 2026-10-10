import type { Index, State } from './core.ts'

const CAP = 8000

export function buildIndexMd(idx: Index, state: State, purposeOf: (module: string) => string): string {
  const head = ['# Wiki index', '', 'Compact map for agents. Treat entries as pointers; verify in the code. Full pages: `.rig/wiki/modules/<name>.md`.', '']
  const mods = Object.values(idx.modules).sort((a, b) => b.usedBy.length - a.usedBy.length || a.name.localeCompare(b.name))
  if (!mods.length) return [...head, '_No modules indexed yet. Once the repo has code, run `/rig-brain:wiki-refresh` to fill this in._', ''].join('\n')
  const lines: string[] = []
  let used = head.join('\n').length
  let i = 0
  for (; i < mods.length; i++) {
    const m = mods[i]
    const stale = state.modules[m.name]?.status === 'stale' ? ' (stale)' : ''
    const syms = m.files.flatMap(f => idx.files[f].symbols.map(s => s.name)).slice(0, 5).join(', ')
    const line = `- **${m.name}**${stale} — ${purposeOf(m.name).replace(/\s+/g, ' ').trim().split('. ')[0].slice(0, 120)} · files: ${m.files.slice(0, 3).map(f => f.split('/').pop()).join(', ')}${syms ? ` · symbols: ${syms}` : ''}`
    if (used + line.length + 1 > CAP - 600) break
    lines.push(line); used += line.length + 1
  }
  let more = ''
  if (i < mods.length) {
    const names: string[] = []
    let len = 'More: '.length
    for (const m of mods.slice(i)) { if (used + len + m.name.length + 2 > CAP - 20) { names.push('…'); break } names.push(m.name); len += m.name.length + 2 }
    more = `More: ${names.join(', ')}`
  }
  return [...head, ...lines, ...(more ? ['', more] : []), ''].join('\n')
}
