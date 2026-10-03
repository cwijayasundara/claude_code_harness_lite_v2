// Tests for the sdlc mod (hooks/register.ts). Run with: claude plugin test .
import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SESSION = { surface: 'terminal' as const, isInteractive: true, cwd: '/work' }

const command = (name: string, args = '', kind: 'composer' | 'sdk' = 'composer') => ({
  command: name,
  args,
  origin: { kind } as { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
})

type Run = { argv: readonly string[]; env?: Record<string, string> }

function worldOf(on: On, { contextTokens = 50_000, costUsd = 1 } = {}) {
  const world = {
    commands: [] as string[], runs: [] as Run[], toasts: [] as string[], notices: [] as string[], costUsd, contextTokens,
    sensors: null as unknown,
    impact: { hold: false, slug: 'add-login', consumers: [] as string[], hits: 0 },
    fileFindings: [] as unknown[],
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('process.run', ($, e) => {
    world.runs.push({ argv: e.argv, env: (e as { init?: { env?: Record<string, string> } }).init?.env })
    const sub = e.argv[3]
    const stdout =
      sub === 'status' ? JSON.stringify({ initialised: true, active: 'add-login', changes: [{ slug: 'add-login', next: { stage: 'build' } }], sensors: world.sensors })
      : sub === 'impact-status' ? JSON.stringify(world.impact)
      : sub === 'check-file' ? JSON.stringify(world.fileFindings)
      : sub === 'sensors' ? 'last gate: 0 block(s)'
      : 'approved add-login plan'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: world.contextTokens, window: 1_000_000, percent: 5 }, rateLimits: [], cost: { usd: world.costUsd } },
  }))
  on('fs.exists', () => ({ value: true }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'slice 1', type: 'sdlc:implementer', status: 'running' }] }))
  on('ui.toast', ($, e) => {
    world.toasts.push(String(e.text ?? e))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.notice', ($, e) => {
    world.notices.push(String((e as { text?: string }).text))
    return { value: undefined }
  })
  return world
}

describe('sdlc mod', () => {
  test('session start registers the zero-token commands', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    expect(world.commands.sort()).toEqual(['sdlc-approve', 'sdlc-sensors', 'sdlc-status', 'sdlc-waive'])
  })

  test('approve runs the script as the human only when the person typed it', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)

    const refused = await $.command.run(command('sdlc-approve', 'add-login plan', 'sdk'))
    expect(refused.text).toContain('only when the person types it')
    expect(world.runs.some(r => r.argv.includes('approve'))).toBe(false)

    const approved = await $.command.run(command('sdlc-approve', 'add-login plan'))
    expect(approved.text).toContain('approved add-login plan')
    const run = world.runs.find(r => r.argv.includes('approve'))
    expect(run?.env).toEqual({ SDLC_HUMAN: '1' })
  })

  test('a main turn logs its token usage and the cost delta from the session ledger', async ($, on) => {
    const world = worldOf(on, { costUsd: 1 })
    on('turn.complete', () => ({ text: '' }))
    await $.session.start(SESSION)

    world.costUsd = 1.25
    await $.turn.complete({
      answer: 'done',
      durationMs: 1000,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
      usage: { model: 'claude-sonnet-5-5', input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 },
    })

    const log = world.runs.find(r => r.argv.includes('log-usage'))
    const row = JSON.parse(String(log?.argv.at(-1)))
    expect(row.kind).toBe('main')
    expect(row.usd).toBe(0.25)
    expect(row.out).toBe(200)
  })

  test('crossing the soft context budget raises one toast', async ($, on) => {
    const world = worldOf(on, { contextTokens: 130_000 })
    on('turn.complete', () => ({ text: '' }))
    await $.session.start(SESSION)
    const turn = { answer: '', durationMs: 1, isAborted: false, reason: 'answer' as const }
    await $.turn.complete({ ...turn, turnId: 't1' })
    await $.turn.complete({ ...turn, turnId: 't2' })
    expect(world.toasts.length).toBe(1)
    expect(world.toasts[0]).toContain('/sdlc:handoff')
  })

  test('waive runs the script as the human only when the person typed it', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    expect((await $.command.run(command('sdlc-waive', 'size * generated', 'sdk'))).text).toContain('only when the person types it')
    await $.command.run(command('sdlc-waive', 'size * generated'))
    expect(world.runs.find(r => r.argv.includes('waive'))?.env).toEqual({ SDLC_HUMAN: '1' })
  })

  test('an edit with no impact hold runs, and gets a per-edit sensor notice', async ($, on) => {
    const world = worldOf(on)
    on('tool.call', () => ({ result: 'edited' }))
    await $.session.start(SESSION)
    const result = await $.tool.call({ tool: 'Edit', tool_use_id: 'tu1', file_path: '/work/src/a.ts', old_string: 'a', new_string: 'b' })
    expect(result.result).toBe('edited')
    expect(world.notices).toEqual(['✓ sdlc'])
  })

  test('an impact hold with no one to ask falls through to the settings hook and approves nothing', async ($, on) => {
    const world = worldOf(on)
    world.impact = { hold: true, slug: 'add-login', consumers: ['checkout'], hits: 2 }
    on('tool.call', ($2, e) => (e.tool === 'AskUserQuestion' ? { deny: 'no one to ask' } : { result: 'edited' }))
    await $.session.start(SESSION)
    const result = await $.tool.call({ tool: 'Edit', tool_use_id: 'tu2', file_path: '/work/../checkout/a.ts', old_string: 'a', new_string: 'b' })
    expect(result.result).toBe('edited')
    expect(world.runs.some(r => r.argv.includes('approve'))).toBe(false)
  })

  test('the band shows failing sensors after a refresh (state is shared with band.tsx)', async ($, on) => {
    const world = worldOf(on)
    world.sensors = { blocks: 1, warns: 0, bySensor: { 'test-tamper': 1 }, unresolved: 1, knownRed: 0, waivers: 0 }
    await $.session.start(SESSION)
    await $.command.run(command('sdlc-waive', 'size * generated'))
    const ui = await $.ui.mount({ plugin: 'sdlc', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 120, scroll: { offset: 0, bodyRows: 5 }, view: {} }, viewport: { columns: 120, rows: 30 } })
    expect(JSON.stringify(await ui.drawn())).toContain('test-tamper(1)')
    await ui.unmount()
  })

  test('the sensors pane shows the report from /sdlc-sensors', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)
    await $.command.run(command('sdlc-sensors'))
    const ui = await $.ui.mount({ plugin: 'sdlc', surface: 'terminal', component: 'Pane', requestId: 'sdlc-sensors', props: { title: 'sdlc sensors', isFocused: false, bodyColumns: 120, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} }, viewport: { columns: 120, rows: 30 } })
    expect(JSON.stringify(await ui.drawn())).toContain('last gate: 0 block(s)')
    await ui.unmount()
  })

  test('an impact hold: Approve impact runs approve as the human, Cancel denies', async ($, on) => {
    const world = worldOf(on)
    world.impact = { hold: true, slug: 'add-login', consumers: ['checkout'], hits: 2 }
    let answer = 'Approve impact'
    on('tool.call', ($2, e) =>
      e.tool === 'AskUserQuestion' ? { result: { questions: e.questions, answers: Object.fromEntries(e.questions.map(q => [q.question, answer])) } } : { result: 'edited' },
    )
    await $.session.start(SESSION)
    const edit = { tool: 'Edit' as const, file_path: '/work/../checkout/a.ts', old_string: 'a', new_string: 'b' }
    const ok = await $.tool.call({ ...edit, tool_use_id: 'tu3' })
    expect(ok.result).toBe('edited')
    expect(world.runs.find(r => r.argv.includes('approve'))?.env).toEqual({ SDLC_HUMAN: '1' })
    world.runs.length = 0
    answer = 'Cancel'
    const no = await $.tool.call({ ...edit, tool_use_id: 'tu4' })
    expect(no.deny).toContain('declined')
    expect(world.runs.some(r => r.argv.includes('approve'))).toBe(false)
  })
})
