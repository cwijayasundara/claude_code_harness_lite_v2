const jsonl = t => t.split('\n').filter(Boolean).map(l => JSON.parse(l))
const fm = text => Object.fromEntries([...(/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '').matchAll(/^([\w-]+):[ \t]*([^\n]*)$/gm)].map(m => [m[1], m[2].trim()]))

export const BAND = { id: 'checkout-errors', query: 'cat .band-value', window: 5, step: 0.5, minSd: 1 }
export const IN_BAND = [10, 11, 10, 9, 10, 10, 11, 10, 9, 10, 10, 11, 10]

export function declareBand(sb) {
  const sensors = JSON.parse(sb.read('.sdlc/sensors.json'))
  sb.write('.sdlc/sensors.json', JSON.stringify({ ...sensors, bands: [BAND] }, null, 2) + '\n')
}

// Records one point through `watch` and returns the band's verdict.
export function feed(sb, value) {
  sb.write('.band-value', `${value}\n`)
  const r = sb.sdlc(['watch', '--json'])
  if (!r.stdout.trim()) throw new Error(`watch printed nothing: ${(r.stderr || '').trim().split('\n')[0]}`)
  return JSON.parse(r.stdout)[0]
}

const breachFiles = sb => sb.run('sh', ['-c', 'ls .sdlc/intent 2>/dev/null | grep -c breach- || true']).stdout.trim()

// The first 13 points are the learning window (5 baseline + the 8 newest, which are kept out of the baseline), so the 13th is the
// first one judged: in-band means tier 0 and no breach name. Then one point far beyond 3 sigma must be tier 3 with a breach name.
// A breach name is given exactly when the tier is 2 or more. `watch` only names the breach; the CI job writes the intent file.
export async function assertWatch(c, sb, { spike = 60, inBand = IN_BAND } = {}) {
  declareBand(sb)
  const seen = inBand.map(v => feed(sb, v))
  await c.check('watch: in-band points are tier 0 and raise no breach', () =>
    seen.every(v => v.tier === 0 && v.breach === null) || JSON.stringify(seen.find(v => v.tier !== 0 || v.breach !== null)))
  const breach = feed(sb, spike)
  seen.push(breach)
  await c.check('watch: a point far beyond 3 sigma is tier 3 with a breach name', () =>
    (breach.tier === 3 && /^breach-checkout-errors-\d{8}$/.test(breach.breach)) || JSON.stringify(breach))
  await c.check('watch: a breach name is given exactly when the tier is 2 or more', () =>
    seen.every(v => (v.tier >= 2) === Boolean(v.breach)) || JSON.stringify(seen.find(v => (v.tier >= 2) !== Boolean(v.breach))))
  await c.check('watch: history holds every point', () => jsonl(sb.read('.sdlc/watch/checkout-errors.jsonl')).length === seen.length)
}

export async function assertIncident(c, sb, file) {
  const f = fm(sb.read(file))
  const missing = ['class', 'severity', 'escaped', 'detected'].filter(k => !f[k])
  await c.check('incident: has class, severity, escaped, detected', () => missing.length === 0 || `missing: ${missing}`)
  await c.check('incident: restored is blank until the fix ships', () => f.restored === '' || f.restored === undefined)
}

export async function assertRestoredMetrics(c, sb, file) {
  sb.write(file, sb.read(file).replace(/^restored:.*$/m, `restored: ${new Date(Date.now() + 3600e3).toISOString()}`))
  sb.commitAll('chore: incident restored')
  const m = JSON.parse(sb.sdlc(['metrics', '--json']).stdout).metrics
  const t = m.time_to_restore_hours
  // Values read `unmeasured` (null) below n=5; what matters is that the restored incident was counted.
  await c.check('metrics: the restored incident is counted in time_to_restore_hours', () => t?.n === 1 || JSON.stringify(t))
  await c.check('metrics: repeat_incident_share is present', () => 'repeat_incident_share' in m || 'missing key')
}
