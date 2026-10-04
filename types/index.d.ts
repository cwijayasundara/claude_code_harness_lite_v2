export type SensorBand = { blocks: number; warns: number; bySensor: Record<string, number>; unresolved: number; knownRed: number; waivers: number }
export type Story = { slug: string; node: string | null; verdict: string; round: number; cap: number; tokens: number; tokensByNode: Record<string, number>; budgetByNode: Record<string, { spent: number; cap: number }>; usd: number; usdByNode: Record<string, number>; valueUsd: number; valueHours: number; autoApproved: number; escalations: number; levels: string; sensors: string }
export type StepInfo = { slug: string; node: string | null; verdict: 'continue' | 'human' | 'blocked' | 'ready'; reason: string; command: string; round: number }
export type Status = { initialised: boolean; active?: string | null; changes?: { slug: string; next?: { stage: string } | null }[]; sensors?: SensorBand | null; story?: Story | null; step?: StepInfo | null }

export type Band = {
  change: string | null
  stage: string | null
  contextTokens: number
  sessionUsd: number
  sensors: SensorBand | null
  story?: Story | null
  step?: StepInfo | null
}

declare module 'claude-code' {
  interface PluginState {
    sdlc: { band: Band | null; isHidden: boolean; paneText: string; metricsText: string; driverRunning: boolean; driverLast: string }
  }
}
