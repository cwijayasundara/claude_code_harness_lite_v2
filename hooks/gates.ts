// The cross-repo impact dialog, at zero tokens. Enforcement and per-edit findings stay in the settings hooks and CI (a notice here cost
// a node start per edit, and core clears it as the call resolves); with no one to ask (-p) the call falls through to them.
import type { EngineInterface, On } from 'claude-code'
import { sdlcArgv, mod, stateChange } from './shared'

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const sdlc = ($: EngineInterface, args: string[]): string[] => sdlcArgv($.plugin.root, ...args)
const isInitialised = ($: EngineInterface): Promise<boolean> => $.fs.exists('.rig')
type Impact = { hold: boolean; slug: string | null; consumers: string[]; hits: number }

// A hold needs the active change to carry impact.json: two file reads, not a node start, before every edit (unsure: ask the script).
async function mayHold($: EngineInterface): Promise<boolean> {
  const change = await $.fs.read('.rig/STATE.md').then(stateChange, () => undefined)
  return change === undefined || (change !== null && (await $.fs.exists(`.rig/changes/${change}/impact.json`)))
}

export function registerGates(on: On): void {
  on('tool.call', async ($, e, next) => {
    if (mod.aside || !EDIT_TOOLS.has(e.tool) || !(await isInitialised($))) return next(e)
    const file = String((e as { file_path?: unknown }).file_path ?? '')
    const impact = file && (await mayHold($)) ? await $.process.run(sdlc($, ['impact-status', file, '--json'])).then(r => JSON.parse(r.stdout) as Impact).catch(() => null) : null
    if (impact?.hold && impact.slug) {
      let answer: string
      try {
        answer = await $.ui.ask(`${file.length > 120 ? '…' + file.slice(-119) : file} is part of a cross-repo contract change: ${impact.hits} reference(s) in ${impact.consumers.join(', ')}. Approve the impact for ${impact.slug}?`, { options: ['Approve impact', 'Cancel'], header: 'Impact' })
      } catch {
        return next(e)
      }
      if (answer !== 'Approve impact') return { deny: `The person declined the cross-repo impact for ${impact.slug}.` }
      const approved = await $.process.run(sdlc($, ['approve', impact.slug, 'impact']), { env: { SDLC_HUMAN: '1' } })
      if (approved.exitCode !== 0) return { deny: (approved.stderr || approved.stdout).trim() || `Could not approve the impact for ${impact.slug}.` }
    }
    return next(e)
  })
}
