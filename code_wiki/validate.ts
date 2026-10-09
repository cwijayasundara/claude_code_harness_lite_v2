import path from 'node:path'
import { keepBlocks } from './compose.ts'

const DIAGRAM = /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey)\b/

export function validatePage(text: string, old: string | null, pageDir: string, exists: (rel: string) => boolean): string[] {
  const problems: string[] = []
  if (!/^---\nmodule: [^\n]+\n[\s\S]*?\n---\n/.test(text)) problems.push('frontmatter missing or malformed')
  for (const m of text.matchAll(/```mermaid\n([\s\S]*?)\n```/g))
    if (!DIAGRAM.test(m[1].trim())) problems.push('mermaid block does not start with a diagram keyword')
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1]
    if (/^[a-z]+:|^#/i.test(href)) continue
    if (!exists(path.posix.normalize(path.posix.join(pageDir, href.split('#')[0])))) problems.push(`link does not resolve: ${href}`)
  }
  for (const k of old ? keepBlocks(old) : []) if (!text.includes(k)) problems.push('a <!-- keep --> block would be dropped')
  return problems
}
