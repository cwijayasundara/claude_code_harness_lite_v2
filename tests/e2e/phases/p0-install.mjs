import { Checks } from '../../integration/lib/checks.mjs'
import { assertOnboarding } from '../../integration/assert/onboarding.mjs'

export const ROUTING = 'sdlc routes all work in this repo: start with /rig-start; use superpowers skills only when an sdlc skill names one.'

const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' | ')}`)
  return r.stdout
}

// What the standalone install does, via the harness's own commands (the live driver instead runs /rig:init with --plugin-dir).
export async function install(sb) {
  sb.isolate([])
  const scripts = { test: 'node --test', 'test-fast': 'node --test', lint: 'node --check src/index.js' }
  sb.write('package.json', JSON.stringify({ name: 'cart', version: '0.1.0', type: 'module', scripts }, null, 2) + '\n')
  sb.write('src/index.js', 'export {}\n')
  sb.write('test/smoke.test.js', "import { test } from 'node:test'\nimport '../src/index.js'\ntest('loads', () => {})\n")
  sb.commitAll('chore: scaffold')
  must(sb.sdlc(['init']), 'init')
  sb.write('.sdlc/sensors.json', JSON.stringify({ fast: { test: 'npm test' }, full: { test: 'npm test' } }, null, 2) + '\n')
  must(sb.sdlc(['init', '--stack']), 'init --stack')
  must(sb.sdlc(['init', '--full']), 'init --full')
  sb.write('CLAUDE.md', `# cart\n\n${ROUTING}\n\n## Map\n- src/\n`)
  sb.commitAll('chore: onboard rig')
  must(sb.sdlc(['preflight', '--answers', '{"gates":"default","valueRate":"100","consumers":"none"}']), 'preflight')
  sb.commitAll('chore: preflight report')
  const c = new Checks('P0 install')
  await assertOnboarding(c, sb, { lane: 'greenfield' })
  return c
}
