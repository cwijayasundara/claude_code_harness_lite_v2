export type SensorBand = { blocks: number; warns: number; bySensor: Record<string, number>; unresolved: number; knownRed: number; waivers: number }
export type Story = { slug: string; node: string | null; verdict: string; round: number; cap: number; tokens: number; tokensByNode: Record<string, number>; budgetByNode: Record<string, { spent: number; cap: number }>; usd: number; usdByNode: Record<string, number>; valueUsd: number; valueHours: number; autoApproved: number; escalations: number; levels: string; sensors: string }
export type StepInfo = { slug: string; node: string | null; verdict: 'continue' | 'human' | 'blocked' | 'ready'; reason: string; command: string; round: number; progress?: number; routes?: Record<string, { model: string; effort: string } | 'main'> }
export type FlowStep = { label: string; command: string; why: string; state: 'done' | 'current' | 'gate' | 'todo' }
export type Status = { initialised: boolean; flow?: FlowStep[]; active?: string | null; changes?: { slug: string; next?: { stage: string } | null }[]; sensors?: SensorBand | null; story?: Story | null; step?: StepInfo | null }

// One captured turn: tokens by kind and the turn's dollars from the session ledger (main turns only; 0 for agents).
export type TurnPoint = { main: boolean; in: number; out: number; cr: number; cw: number; usd: number }

export type Band = {
  change: string | null
  stage: string | null
  contextTokens: number
  sessionUsd: number
  sensors: SensorBand | null
  story?: Story | null
  step?: StepInfo | null
  flow?: FlowStep[]
}

declare module 'claude-code' {
  interface PluginState {
    rig: { band: Band | null; isHidden: boolean; paneText: string; metricsText: string; driverRunning: boolean; driverLast: string; turns: TurnPoint[] }
  }
}
