// The fake model: plays each work node the way the skills do, from the phase's fixture files.
import fs from 'node:fs'
import path from 'node:path'

const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' | ')}`)
  return r.stdout
}
const intentMd = (sb, slug, p) => {
  const cur = sb.read(`.sdlc/changes/${slug}/intent.md`)
  const head = /^---\n[\s\S]*?\n---\n/.exec(cur)[0]
  return `${head}# ${p.title}\n\n## Problem\n${p.intent.problem}\n\n## Outcome\n${p.intent.outcome}\n\n## Non-goals\n${p.intent.nonGoals}\n\n## Risks\n${p.intent.risks}\n\n## Decisions\nnone\n\n## Open questions\nnone\n`
}
const copy = (sb, files) => files.forEach(f => { fs.mkdirSync(path.dirname(sb.file(f.dest)), { recursive: true }); fs.copyFileSync(f.src, sb.file(f.dest)) })

export function scriptedDriver(sb, phase) {
  const slug = phase.slug
  const dir = `.sdlc/changes/${slug}`
  return {
    async begin() {
      sb.git('checkout', '-q', '-b', `sdlc/${slug}`)
      must(sb.sdlc(['new', slug, '--type', phase.type, '--tier', phase.tier, '--title', phase.title]), 'new')
      sb.write(`${dir}/intent.md`, intentMd(sb, slug, phase))
      return slug
    },
    async step(node) {
      switch (node) {
        case 'design': sb.write(`${dir}/design.md`, phase.design); break
        case 'build':
          copy(sb, phase.tests)
          must(sb.sdlc(['run', '--slug', slug, '--expect-fail', '--', 'npm test']), 'red run')
          copy(sb, phase.impl)
          must(sb.sdlc(['run', '--slug', slug, '--', 'npm test']), 'green run')
          must(sb.sdlc(['ratchet', 'record', slug, 'build', '--slice', '1', '--checks']), 'record slice 1')
          break
        case 'test': must(sb.sdlc(['verify', slug]), 'verify'); break
        case 'sensors': must(sb.sdlc(['quality', slug]), 'quality'); break
        case 'pr': must(sb.sdlc(['pr', slug, '--message', phase.commit]), 'pr'); break
        case 'pr-review':
          sb.write(`${dir}/review-pr.md`, 'verdict: pass\n')
          sb.write(`${dir}/review.md`, '---\nresult: pass\nrounds: 1\ncaught: 0\n---\n# Review\n\nNo findings.\n')
          must(sb.sdlc(['ratchet', 'record', slug, 'pr-review', '--from', `${dir}/review-pr.md`]), 'record pr-review')
          must(sb.sdlc(['pr-checks', slug]), 'pr-checks')
          break
        default: throw new Error(`scripted driver has no handler for node ${node}`)
      }
    },
  }
}
