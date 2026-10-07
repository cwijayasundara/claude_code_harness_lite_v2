// A named list of PASS/FAIL results. A check returns true to pass; anything else (or a throw) fails with that as the reason.
export class Checks {
  constructor(title) {
    this.title = title
    this.results = []
  }

  async check(name, fn) {
    try {
      const ok = await fn()
      this.results.push({ status: ok === true ? 'PASS' : 'FAIL', name, why: ok === true ? '' : String(ok) })
    } catch (err) {
      this.results.push({ status: 'FAIL', name, why: String(err?.message ?? err).split('\n')[0] })
    }
  }

  get failed() {
    return this.results.filter(r => r.status === 'FAIL')
  }

  print(log = console.log) {
    for (const r of this.results) log(`${r.status}  ${r.name}${r.why ? `  (${r.why})` : ''}`)
    log(`${this.title}: ${this.results.length - this.failed.length}/${this.results.length} checks passed`)
  }

  toJSON() {
    return { title: this.title, passed: this.results.length - this.failed.length, total: this.results.length, results: this.results }
  }
}
