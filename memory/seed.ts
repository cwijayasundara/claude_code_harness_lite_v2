import fs from 'node:fs'
import path from 'node:path'
import { applyOps, writeStore, type ApplyResult } from './apply.ts'
import { loadMemConfig, memDir } from './config.ts'
import { DEFAULT_TOPICS, loadStore, serializeTopic } from './store.ts'
import { readJson, writeJson } from '../shared/json.ts'

const FILL_IN: Record<string, string> = {
  'commands.md': 'build, test and run commands that work',
  'gotchas.md': 'traps and environment quirks as you hit them',
  'dead-ends.md': 'approaches tried and ruled out, and why',
  'conventions.md': 'repo norms you learn from corrections',
}

// One-time setup from /rig:init: turn memory on, optionally lay down placeholder topic files, add the given entries.
// Never overwrites an existing memory.json or topic file, so a re-run only adds what is missing.
export function seedMemory(root: string, ops: unknown, today: string, opts: { placeholders?: boolean } = {}): ApplyResult {
  const cfgFile = path.join(root, '.sdlc/memory.json')
  if (!fs.existsSync(cfgFile)) writeJson(cfgFile, { enabled: true })
  else if (readJson<Record<string, unknown>>(cfgFile, {}).enabled !== true) throw new Error('.sdlc/memory.json exists with memory disabled: not overriding it')
  if (opts.placeholders) {
    fs.mkdirSync(memDir(root), { recursive: true })
    for (const [file, description] of Object.entries(DEFAULT_TOPICS)) {
      const f = path.join(memDir(root), file)
      if (!fs.existsSync(f)) fs.writeFileSync(f, serializeTopic({ file, description, lines: [`_(fill in: ${FILL_IN[file]})_`] }))
    }
  }
  const res = applyOps(root, loadMemConfig(root), ops, today)
  writeStore(root, loadStore(root))
  return res
}
