import fs from 'node:fs'
import path from 'node:path'

export function ensureCacheIgnore(dir: string): void {
  const f = path.join(dir, '.gitignore')
  if (fs.existsSync(f)) return
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(f, '.cache/\n')
}
