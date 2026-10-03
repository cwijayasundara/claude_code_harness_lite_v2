export type SensorBand = { blocks: number; warns: number; bySensor: Record<string, number>; unresolved: number; knownRed: number; waivers: number }
export type Status = { initialised: boolean; active?: string | null; changes?: { slug: string; next?: { stage: string } | null }[]; sensors?: SensorBand | null }

export type Band = {
  change: string | null
  stage: string | null
  contextTokens: number
  sessionUsd: number
  sensors: SensorBand | null
}

declare module 'claude-code' {
  interface PluginState {
    sdlc: { band: Band | null; isHidden: boolean; paneText: string }
  }
}
