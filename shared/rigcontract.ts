import fs from 'node:fs'
import path from 'node:path'

export const MIN_RIG = '0.6.0'

const num = (v: string): number[] => v.split('.').map(n => parseInt(n, 10) || 0)
const gte = (a: string, b: string): boolean => {
  const x = num(a), y = num(b)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return true
}

export function checkRig(root: string): { present: boolean; version: string | null; supported: boolean } {
  // rig is present when .sdlc/ holds anything besides this plugin's own files (wiki/, wiki.json)
  const own = new Set(['wiki', 'wiki.json'])
  const hasRig = (() => { try { return fs.readdirSync(path.join(root, '.sdlc')).some(e => !own.has(e)) } catch { return false } })()
  if (!hasRig) return { present: false, version: null, supported: true }
  let version: string | null = null
  try { version = fs.readFileSync(path.join(root, '.sdlc/bin/VERSION'), 'utf8').trim() || null } catch { /* unreadable */ }
  return { present: true, version, supported: version !== null && gte(version, MIN_RIG) }
}
