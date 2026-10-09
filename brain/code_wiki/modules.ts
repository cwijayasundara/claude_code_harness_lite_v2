import { type Config, globToRegExp } from './config.ts'
import { safeName } from './core.ts'

export function moduleOf(file: string, cfg: Config): string {
  for (const [glob, name] of Object.entries(cfg.modules)) if (globToRegExp(glob).test(file)) return safeName(name)
  const seg = file.split('/')
  for (const root of cfg.moduleRoots) {
    const parts = root.split('/')
    if (seg.length <= parts.length) continue
    if (!parts.every((p, i) => p === '*' || p === seg[i])) continue
    if (parts.at(-1) === '*') return safeName(seg[parts.length - 1])
    return safeName(seg.length > parts.length + 1 ? seg[parts.length] : parts.at(-1)!)
  }
  return seg.length > 1 ? safeName(seg[0]) : 'root'
}
