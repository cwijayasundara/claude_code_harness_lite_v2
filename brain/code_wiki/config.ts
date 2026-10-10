import path from 'node:path'
import { readJson } from './core.ts'

export type Config = { moduleRoots: string[]; modules: Record<string, string>; maxPages: number; ignore: string[] }

export function loadConfig(root: string): Config {
  const own = readJson<Partial<Config>>(path.join(root, '.rig/wiki.json'), {})
  const rig = readJson<{ ignore?: string[] }>(path.join(root, '.rig/sensors.json'), {})
  return {
    moduleRoots: own.moduleRoots ?? ['src', 'scripts', 'packages/*', 'lib', 'app'],
    modules: own.modules ?? {},
    maxPages: own.maxPages ?? 25,
    ignore: [...(own.ignore ?? []), ...(Array.isArray(rig.ignore) ? rig.ignore : [])],
  }
}

export function globToRegExp(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
  return new RegExp(`^${re}$`)
}
