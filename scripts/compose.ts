import type { Index, ModuleInfo } from './core.ts'
import type { Why } from './why.ts'

export type Prose = { purpose: string; how: string; mermaid?: string }

export function getBlock(text: string, name: string): string | null {
  const m = text.match(new RegExp(`<!-- ${name} -->\\n([\\s\\S]*?)\\n<!-- /${name} -->`))
  return m ? m[1] : null
}

export const keepBlocks = (text: string): string[] => text.match(/<!-- keep -->[\s\S]*?<!-- \/keep -->/g) ?? []

const block = (name: string, body: string) => `<!-- ${name} -->\n${body}\n<!-- /${name} -->`
const link = (n: string) => `- [${n}](${n}.md)`

export function composePage(a: { mod: ModuleInfo; idx: Index; prose: Prose | null; old: string | null; stale: boolean; why: Why[]; generated: string }): string | null {
  const { mod, idx, old } = a
  let purpose: string, how: string, mermaid: string | undefined
  if (mod.structureOnly) { purpose = 'Structure only: no symbol extraction for this language.'; how = '_No narrative for structure-only modules._' }
  else if (a.prose) { purpose = a.prose.purpose; how = a.prose.how; mermaid = a.prose.mermaid }
  else {
    const op = old && getBlock(old, 'purpose'), oh = old && getBlock(old, 'how')
    if (!op || !oh) return null
    purpose = op
    const fenced = oh.match(/\n\n```mermaid\n([\s\S]*?)\n```$/)
    how = fenced ? oh.slice(0, fenced.index) : oh
    mermaid = fenced?.[1]
  }
  const syms = mod.files.flatMap(f => idx.files[f].symbols)
  const api = syms.length
    ? ['| Symbol | Kind | Signature |', '|---|---|---|', ...syms.map(s => `| ${s.name} | ${s.kind} | ${s.signature.replace(/\|/g, '\\|')} |`)].join('\n')
    : '_No exported symbols extracted._'
  const list = (xs: string[]) => (xs.length ? xs.map(link).join('\n') : '_none_')
  const whyLines = a.why.length ? a.why.map(w => `- [${w.slug}](../../changes/${w.slug}/intent.md): ${w.intent}`).join('\n') : '_No rig changes recorded._'
  const kept = old ? keepBlocks(old) : []
  return [
    '---', `module: ${mod.name}`, `files: [${mod.files.join(', ')}]`, `hash: ${mod.hash}`, `generated: ${a.generated}`,
    `status: ${mod.structureOnly ? 'structure-only' : a.stale ? 'stale' : 'fresh'}`, `changes: [${a.why.map(w => w.slug).join(', ')}]`, '---',
    `# ${mod.name}`, '',
    ...(a.stale && !mod.structureOnly ? ['> **Stale:** this page\'s narrative predates recent code changes.', ''] : []),
    '## Purpose', block('purpose', purpose), '',
    '## Public API', api, '',
    '## Depends on', list(mod.dependsOn), '',
    '## Used by', list(mod.usedBy), '',
    '## How it works', block('how', mermaid ? `${how}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`` : how), '',
    '## Why it is this way', whyLines, '',
    ...(kept.length ? [kept.join('\n\n'), ''] : []),
  ].join('\n')
}
