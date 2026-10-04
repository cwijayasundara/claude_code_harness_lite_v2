// Pure helpers for the zero-token driver (spec §8.4). The loop itself lives in register.ts: the mod loader follows `$`
// only within one file and allows a single turn.complete hook, so the code that holds `$` stays beside it.
import type { StepInfo } from '../types'

export const promptFor = (s: StepInfo, root: string): string =>
  `rig driver: run \`node --disable-warning=ExperimentalWarning ${root}/scripts/sdlc.ts skill ${s.node} ${s.slug}\` and follow the printed steps exactly for this one node, then stop. Do not run \`skill next\`: /rig-run continues after this turn.`

// The gate a human step waits at, from its command text ("... then run /rig-approve <slug> <gate>").
export const gateOf = (s: StepInfo): string | undefined => /\/rig-approve \S+ (\w+)/.exec(s.command)?.[1]

// Same node, round and finished-slice count after a turn means the turn moved nothing (a build slice done is progress).
export const stepKey = (s: StepInfo): string => `${s.node}:${s.round}:${s.progress ?? 0}`
