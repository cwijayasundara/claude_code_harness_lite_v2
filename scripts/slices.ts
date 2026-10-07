// A plan's slices: `### Task N` blocks and the paths each lists on a `Files:` line.
export function sliceFiles(planText: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const block of planText.split(/^(?=###\s+Task\s+\d+\b)/m)) {
    const id = /^###\s+Task\s+(\d+)\b/.exec(block)?.[1]
    if (!id) continue
    out[id] = filesOf(block)
  }
  return out
}

const paths = (text: string): string[] => [...text.matchAll(/`([^`\s]+)`/g)].map(m => m[1] ?? '').filter(Boolean)

// The inline paths on a `Files:` line, plus the bullets directly under it (until a blank line or heading).
function filesOf(block: string): string[] {
  const lines = block.split('\n')
  const at = lines.findIndex(l => /^\s*(?:[-*]\s*)?\**Files?:?\**:?(?:\s|$)/i.test(l))
  if (at < 0) return []
  const found = paths((lines[at] ?? '').replace(/^\s*(?:[-*]\s*)?\**Files?:?\**:?/i, ''))
  for (const l of lines.slice(at + 1)) {
    if (!/^\s*[-*]\s/.test(l)) break
    found.push(...paths(l))
  }
  return found
}
