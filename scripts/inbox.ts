// The intent inbox (.sdlc/intent/*.md): ideas a product owner commits before any change exists. People write `status:`
// (draft | accepted | closed); `shipped` is derived from the change whose intent.md names the file as its `source:`.
import fs from 'node:fs'
import path from 'node:path'
import { SDLC, CHANGES, exists, read, out, frontmatter, listChanges, isShipped, git, type Args, type ChangeType, type Tier } from './core.ts'
import { modelFor, isChangeType, isTier, type ModelAlias } from './graph.ts'

export const INBOX = path.join(SDLC, 'intent')
export type InboxEntry = { file: string; status: 'draft' | 'accepted' | 'closed' | 'shipped' | 'unknown'; change: string | null; type: ChangeType | null; tier: Tier | null; model: ModelAlias }
const DECLARED = ['draft', 'accepted', 'closed'] as const
const KEBAB_MD = /^[a-z0-9][a-z0-9-]{0,60}\.md$/

export function inboxEntries(): InboxEntry[] {
  if (!exists(INBOX)) return []
  const bySource = new Map<string, string>()
  for (const slug of listChanges()) {
    const source = frontmatter(read(path.join(CHANGES, slug, 'intent.md'))).data.source
    if (source) bySource.set(path.basename(source), slug)
  }
  return fs.readdirSync(INBOX).filter(f => f.endsWith('.md')).sort().map(file => {
    const d = frontmatter(read(path.join(INBOX, file))).data
    const change = bySource.get(file) ?? null
    const declared = (DECLARED as readonly string[]).includes(d.status ?? '') ? (d.status as InboxEntry['status']) : 'unknown'
    const type = isChangeType(d.type) ? d.type : null
    const tier = isTier(d.tier) ? d.tier : null
    // No valid tier is a doubt, and a doubt is Opus (M0's rule).
    return { file, status: change && isShipped(change) ? 'shipped' : declared, change, type, tier, model: tier ? modelFor(type ?? 'feature', tier) : 'opus' }
  })
}

export const specBranch = (file: string): string => `sdlc/intent-${file.replace(/\.md$/, '')}`

// What the rig-spec workflow drafts: accepted, a plain name, no change yet, and no draft branch already on the remote.
export const pendingIntents = (): InboxEntry[] => inboxEntries().filter(e =>
  e.status === 'accepted' && !e.change && KEBAB_MD.test(e.file) && git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${specBranch(e.file)}`]) === null)

export function cmdInbox(args: Args): void {
  const rows = args.opt.pending ? pendingIntents() : inboxEntries()
  if (args.opt.json) return out(JSON.stringify(rows))
  out(rows.length ? rows.map(e => `${e.status.padEnd(9)}${e.file}${e.change ? ` → ${e.change}` : ''}`).join('\n') : 'intent inbox is empty (.sdlc/intent/)')
}
