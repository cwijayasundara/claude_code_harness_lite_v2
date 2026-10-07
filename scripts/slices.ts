// A plan's slices: `### Task N` blocks and the paths each lists on a `Files:` line.
export function sliceFiles(planText: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const block of planText.split(/^(?=###\s+Task\s+\d+\b)/m)) {
    const id = /^###\s+Task\s+(\d+)\b/.exec(block)?.[1]
    if (!id) continue
    const line = /^\s*(?:[-*]\s*)?\**Files?:?\**:?\s*(.+)$/im.exec(block)?.[1] ?? ''
    out[id] = [...line.matchAll(/`([^`\s]+)`/g)].map(m => m[1] ?? '').filter(Boolean)
  }
  return out
}
