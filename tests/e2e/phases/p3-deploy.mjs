import { Checks } from '../../integration/lib/checks.mjs'
import { assertProductionGate, assertRollbackRehearsal, assertWorkflows } from '../assert/deploy.mjs'

export async function runDeploy(sb) {
  const c = new Checks('P3 deploy (local)')
  await assertProductionGate(c, sb)
  await assertRollbackRehearsal(c, sb)
  await assertWorkflows(c)
  return c
}
