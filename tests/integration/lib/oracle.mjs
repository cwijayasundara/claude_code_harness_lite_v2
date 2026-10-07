// What the harness itself says a change should go through, asked of the repo's own vendored checker, so the assertions
// follow the harness instead of restating it. core.ts reads the repo root once at import, so each question runs in a child.
// Usage as a script: node oracle.mjs <repo> <slug>   (prints JSON)
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function oracle(repo, slug) {
  const r = spawnSync('node', ['--disable-warning=ExperimentalWarning', import.meta.filename, repo, slug], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  })
  if (r.status !== 0) throw new Error(`oracle: ${(r.stderr || r.stdout).trim().split('\n')[0]}`)
  return JSON.parse(r.stdout)
}

// The repo's parsed sensors.json, its parse errors, and the harness defaults it is compared against.
export const configOf = repo => oracle(repo, '--config')

if (process.argv[1] === import.meta.filename) {
  const [repo, slug] = process.argv.slice(2)
  process.env.CLAUDE_PROJECT_DIR = repo
  const bin = rel => import(pathToFileURL(path.join(repo, '.sdlc/bin', rel)).href)
  if (slug === '--config') {
    const { loadConfig } = await bin('check.ts')
    const { parseConfig } = await bin('model.ts')
    const { config, errors } = loadConfig()
    console.log(JSON.stringify({ config, errors, defaults: parseConfig('').config }))
    process.exit(0)
  }
  const { loadChange, step } = await bin('graph.ts')
  const { requiredLevels } = await bin('levels.ts')
  const { loadConfig } = await bin('check.ts')
  const { read, planPath } = await bin('core.ts')
  const change = loadChange(slug)
  const { config } = loadConfig()
  const levels = change.type === 'spike' ? [] : requiredLevels(change, read(planPath(slug)), config)
  const { type, tier, stages, gates, next } = change
  console.log(JSON.stringify({ slug, type, tier, stages, gates, next, step: step(slug), levels, plan: path.basename(planPath(slug)) }))
}
