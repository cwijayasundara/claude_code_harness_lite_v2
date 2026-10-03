export type Band = {
  change: string | null
  stage: string | null
  contextTokens: number
  sessionUsd: number
}

declare module 'claude-code' {
  interface PluginState {
    sdlc: { band: Band | null; isHidden: boolean }
  }
}
