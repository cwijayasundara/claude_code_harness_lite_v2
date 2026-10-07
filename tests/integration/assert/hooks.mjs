// The git hooks, exercised the way a person or another editor meets them (with hooks on, unlike /rig-pr's --no-verify).
import crypto from 'node:crypto'

// A staged secret must be refused at commit. The secret is made at run time, so none is ever committed to the plugin.
export async function assertPreCommitRefusesSecret(c, sb) {
  const file = 'src/leak.js'
  // Assembled here so this source never itself reads as a secret assignment.
  const assignment = ['export const apiKey', '=', JSON.stringify(crypto.randomBytes(16).toString('hex'))].join(' ')
  sb.write(file, `${assignment}\n`)
  try {
    sb.git('add', file)
    const r = sb.run('git', ['commit', '-q', '-m', 'operator: should be refused'])
    const said = (r.stdout + r.stderr).trim()
    await c.check('pre-commit refuses a staged secret', () =>
      (r.status !== 0 && /secret/i.test(said)) || `exit ${r.status}: ${said.split('\n').slice(0, 2).join(' ')}`)
  } finally {
    if (sb.git('log', '-1', '--format=%s') === 'operator: should be refused') sb.git('reset', '-q', '--hard', 'HEAD~1')
    sb.run('git', ['rm', '-q', '--cached', '--force', file])
    sb.run('rm', ['-f', sb.file(file)])
  }
}

// /rig-pr pushes sdlc/<slug> with --no-verify, and re-pushing an up-to-date ref runs no hook, so push to a fresh ref.
export async function assertPrePushPasses(c, sb, slug) {
  const r = sb.run('git', ['push', 'origin', `HEAD:refs/heads/prepush-${slug}`])
  const said = (r.stdout + r.stderr).trim()
  await c.check(`${slug}: pre-push runs the ship checks and passes`, () =>
    (r.status === 0 && /sdlc check push: pass/.test(said)) || `exit ${r.status}: ${said.split('\n').slice(0, 3).join(' ')}`)
}
