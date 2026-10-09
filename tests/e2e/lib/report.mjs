import fs from 'node:fs'
import path from 'node:path'

export function writeReport(out, list) {
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(list.map(c => c.toJSON()), null, 2))
  const md = list.map(c => `## ${c.title}\n\n${c.results.map(r => `- ${r.status} ${r.name}${r.why ? ` (${r.why})` : ''}`).join('\n')}\n`).join('\n')
  fs.writeFileSync(path.join(out, 'report.md'), `# e2e report\n\n${md}`)
}
