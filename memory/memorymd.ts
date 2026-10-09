import { type Store, entries } from './store.ts'

export const MEMORY_HEADER = 'Notes from past sessions in this repo. Verify before relying on them.'
const MAX_LINES = 60

export function buildMemoryMd(s: Store): string {
  const name = (file: string) => file.replace(/\.md$/, '')
  const topics = [...s.values()].filter(t => entries(t).length > 0).sort((a, b) => a.file.localeCompare(b.file))
  const recent = topics.flatMap(t => entries(t).map(e => ({ e, t: name(t.file) })))
    .sort((a, b) => b.e.added.localeCompare(a.e.added) || b.e.id.localeCompare(a.e.id)).slice(0, 10)
  const out = ['# Memory', MEMORY_HEADER, 'Search with `/rig-util:memory-find <terms>` or grep `.sdlc/memory/`.', '', '## Topics',
    ...(topics.length ? topics.map(t => `- [[${name(t.file)}]] (${entries(t).length}): ${t.description}`) : ['- (none yet)'])]
  if (recent.length) out.push('', '## Recent', ...recent.map(r => `- ${r.e.text} ([[${r.t}]], ${r.e.id})`))
  return out.slice(0, MAX_LINES).join('\n') + '\n'
}
