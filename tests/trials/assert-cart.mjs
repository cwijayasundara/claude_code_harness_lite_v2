// Deterministic checks for the cart lifecycle (run-trials.sh C): one repo, three shipped changes in order.
// Usage: node assert-cart.mjs <scaffold|cart|coupon|bulk> <repo> <plugin-root>
// Runs after each phase, before the operator merges the change branch into main.
import fs from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const [phase, repo, plugin] = process.argv.slice(2)
const file = rel => path.join(repo, rel)
const read = rel => (fs.existsSync(file(rel)) ? fs.readFileSync(file(rel), 'utf8') : '')
const sdlc = (...args) => execFileSync('node', ['--disable-warning=ExperimentalWarning', path.join(plugin, 'scripts/sdlc.ts'), ...args], {
  cwd: repo, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
})
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const results = []
const check = async (name, fn) => {
  try {
    const ok = await fn()
    results.push([ok === true ? 'PASS' : 'FAIL', name, ok === true ? '' : String(ok)])
  } catch (err) {
    results.push(['FAIL', name, err.message.split('\n')[0]])
  }
}
const created = slug => (/^created: (.+)$/m.exec(read(`.sdlc/changes/${slug}/intent.md`)) ?? [])[1] ?? ''
const orderedChanges = () => (JSON.parse(sdlc('status', '--json')).changes ?? []).filter(c => !c.slug.startsWith('adhoc-')).sort((a, b) => created(a.slug).localeCompare(created(b.slug)))
const INDEX = { cart: 0, coupon: 1, bulk: 2 }
const change = () => orderedChanges()[INDEX[phase]]
const changeFile = name => read(`.sdlc/changes/${change().slug}/${name}`)
const approvals = () => read('.sdlc/approvals.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(a => a.slug === change().slug)
const load = async () => import(`${file('src/cart.js')}?t=${Date.now()}`)
const throwsOf = (fn, Type) => { try { fn() } catch (e) { return e instanceof (Type ?? Error) ? e : null } return null }
const cartOf = async rows => { const { Cart } = await load(); const c = new Cart(); for (const [sku, price, qty] of rows) c.add(sku, price, qty); return c }

// What each change promises; later phases re-run the earlier promises, so a regression in old behaviour fails the new phase.
const promises = {
  async cart() {
    const c = await cartOf([['B-2', 250, 2], ['A-1', 100], ['B-2', 250, 1]])
    if (!isDeepStrictEqual(c.lines(), [{ sku: 'A-1', qty: 1, priceCents: 100 }, { sku: 'B-2', qty: 3, priceCents: 250 }])) return `lines ${JSON.stringify(c.lines())}`
    if (c.totalCents() !== 850) return `total ${c.totalCents()}`
    if (!throwsOf(() => c.remove('NOPE'))) return 'remove of an absent SKU did not throw'
    c.remove('A-1')
    if (c.totalCents() !== 750) return `total after remove ${c.totalCents()}`
    for (const bad of [0, -1, 1.5]) if (!throwsOf(() => c.add('X', 10, bad), RangeError)) return `add qty ${bad} did not throw RangeError`
    if (!throwsOf(() => c.add('X', -5), RangeError) || !throwsOf(() => c.add('X', 1.5), RangeError)) return 'bad priceCents did not throw RangeError'
    return true
  },
  async coupon() {
    const c = await cartOf([['A-1', 1999]])
    c.applyCoupon('SAVE10')
    if (c.totalCents() !== 1799) return `SAVE10 on 1999 gave ${c.totalCents()}, want 1799`
    c.applyCoupon('SAVE10')
    if (c.totalCents() !== 1799) return `second SAVE10 stacked: ${c.totalCents()}`
    const e = throwsOf(() => c.applyCoupon('BOGUS'))
    if (!e || !/unknown coupon/i.test(e.message)) return 'unknown coupon did not throw "unknown coupon"'
    return true
  },
  async bulk() {
    const a = await cartOf([['A-1', 100, 10]])
    if (a.totalCents() !== 950) return `qty 10 at 100 gave ${a.totalCents()}, want 950`
    const b = await cartOf([['A-1', 100, 9]])
    if (b.totalCents() !== 900) return `qty 9 at 100 gave ${b.totalCents()}, want 900`
    const c = await cartOf([['A-1', 333, 10], ['B-2', 50, 2]])
    if (c.totalCents() !== 3163 + 100) return `mixed cart gave ${c.totalCents()}, want 3263`
    c.applyCoupon('SAVE10')
    if (c.totalCents() !== Math.floor(3263 * 90 / 100)) return `coupon after bulk gave ${c.totalCents()}, want ${Math.floor(3263 * 90 / 100)}`
    const d = await cartOf([['A-1', 100, 5], ['A-1', 100, 5]])
    if (d.totalCents() !== 950) return `repeat adds summing to 10 gave ${d.totalCents()}, want 950`
    return true
  },
}

if (phase === 'scaffold') {
  await check('package.json has a test script and is ESM', () => { const p = JSON.parse(read('package.json') || '{}'); return (Boolean(p.scripts?.test) && p.type === 'module') || JSON.stringify(p.scripts) })
  await check('CLAUDE.md carries the sdlc routing line', () => /sdlc routes all work in this repo/.test(read('CLAUDE.md')) || 'missing')
  await check('.sdlc/sensors.json declares a test command', () => { const c = JSON.parse(read('.sdlc/sensors.json')); return Object.values({ ...c.fast, ...c.full }).some(cmd => /test/.test(cmd)) || JSON.stringify(c) })
  await check('sensors.json declares the unit, integration and acceptance levels tier L requires', () => { const l = JSON.parse(read('.sdlc/sensors.json')).levels ?? {}; const miss = ['unit', 'integration', 'acceptance'].filter(k => !l[k]); return miss.length === 0 || `undeclared: ${miss.join(', ')}` })
  await check('the scaffold is committed on main', () => git('log', '--oneline').split('\n').length >= 2 && git('rev-parse', '--abbrev-ref', 'HEAD') === 'main' || 'no scaffold commit on main')
  await check('the smoke test passes', () => { execFileSync('npm', ['test', '--silent'], { cwd: repo, stdio: 'pipe' }); return true })
} else {
  await check('a change was recorded for this phase', () => Boolean(change()) || `only ${orderedChanges().length} change(s)`)
  await check('the change is done (shipped)', () => /^done/.test(change().command) || change().command)
  await check('committed on a branch, not main', () => !/^(?:main|master)$/.test(git('rev-parse', '--abbrev-ref', 'HEAD')) || 'still on main')
  await check('working tree is clean after ship', () => { const dirty = git('status', '--porcelain').split('\n').filter(l => l && !/\.sdlc\/(?:STATE\.md|usage\.jsonl)$/.test(l)); return dirty.length === 0 || dirty.join('; ') })
  await check('no unresolved quality-gate findings', () => !fs.existsSync(file('.sdlc/unresolved.json')) || read('.sdlc/unresolved.json').slice(0, 200))
  await check('verification.md was generated by sdlc and passed', () => (/generated: sdlc/.test(changeFile('verification.md')) && /result: pass/.test(changeFile('verification.md'))) || 'missing or not passing')
  await check('a red run was recorded (test first)', () => /"expectFail":true/.test(changeFile('runs.jsonl')) || 'no --expect-fail run')
  await check('the operator approved at least one human gate', () => { const s = approvals().map(a => a.stage); return s.length > 0 || 'no approval recorded' })
  await check('npm test passes on the shipped branch', () => { execFileSync('npm', ['test', '--silent'], { cwd: repo, stdio: 'pipe' }); return true })
  await check('wiki status is clean', () => { const s = JSON.parse(sdlc('wiki', 'status', '--json')); return s.none || [...s.stale, ...s.missing, ...s.uncovered].length === 0 || JSON.stringify(s) })
  const promised = ['cart', 'coupon', 'bulk'].slice(0, INDEX[phase] + 1)
  for (const p of promised) await check(`${p === phase ? 'hidden acceptance' : 'no regression'}: ${p} promises`, () => promises[p]())
  if (phase !== 'cart') {
    await check('existing code was modified, not rewritten from scratch', () => {
      const stat = git('diff', '--numstat', 'main', 'HEAD', '--', 'src/cart.js').split('\t')
      const [add, del] = [Number(stat[0]), Number(stat[1])]
      const old = git('show', 'main:src/cart.js').split('\n').length
      return (add > 0 && del < old * 0.8) || `+${add} -${del} against ${old} old lines`
    })
  }
}

for (const [status, name, why] of results) console.log(`${status}  ${name}${why ? `  (${why})` : ''}`)
const failed = results.filter(r => r[0] === 'FAIL').length
console.log(`${phase}: ${results.length - failed}/${results.length} checks passed`)
process.exitCode = failed ? 1 : 0
