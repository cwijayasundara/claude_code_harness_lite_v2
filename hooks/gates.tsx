// Human-facing gates at zero tokens: the cross-repo impact dialog and per-edit sensor notices.
// Enforcement stays in the settings hooks and CI; with no one to ask (-p) the call falls through to them.
import type { EngineInterface, On } from 'claude-code'
import { sdlcArgv } from './shared'

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const sdlc = ($: EngineInterface, args: string[]): string[] => sdlcArgv($.plugin.root, ...args)
const isInitialised = ($: EngineInterface): Promise<boolean> => $.fs.exists('.sdlc')
type Impact = { hold: boolean; slug: string | null; consumers: string[]; hits: number }
type FileFinding = { severity: string; sensor: string; file?: string; line?: number }

async function json<T>($: EngineInterface, args: string[]): Promise<T | null> {
  try {
    return JSON.parse((await $.process.run(sdlc($, args))).stdout) as T
  } catch {
    return null
  }
}

async function notice($: EngineInterface, toolUseId: string, file: string): Promise<void> {
  const findings = (await json<FileFinding[]>($, ['check-file', file, '--json'])) ?? []
  const blocks = findings.filter(f => f.severity === 'block')
  const first = blocks[0]
  $.ui.notice(toolUseId, first ? `✗ ${first.sensor}: ${first.file ?? ''}${first.line ? ':' + first.line : ''}${blocks.length > 1 ? ` (+${blocks.length - 1})` : ''}` : '✓ sdlc')
}

export function registerGates(on: On): void {
  on('tool.call', async ($, e, next) => {
    if (!EDIT_TOOLS.has(e.tool) || !(await isInitialised($))) return next(e)
    const file = String((e as { file_path?: unknown }).file_path ?? '')
    const impact = file ? await json<Impact>($, ['impact-status', file, '--json']) : null
    if (impact?.hold && impact.slug) {
      let answer: string
      try {
        answer = await $.ui.ask(`${file} is part of a cross-repo contract change: ${impact.hits} reference(s) in ${impact.consumers.join(', ')}. Approve the impact for ${impact.slug}?`, { options: ['Approve impact', 'Cancel'], header: 'Impact' })
      } catch {
        return next(e)
      }
      if (answer !== 'Approve impact') return { deny: `The person declined the cross-repo impact for ${impact.slug}.` }
      await $.process.run(sdlc($, ['approve', impact.slug, 'impact']), { env: { SDLC_HUMAN: '1' } })
    }
    const result = await next(e)
    if (file && !result.deny) await notice($, e.tool_use_id, file)
    return result
  })
}
