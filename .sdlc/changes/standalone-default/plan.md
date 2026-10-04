# Plan: standalone-default

## Approach
Reuse `vendor --cloud` (already copies scripts, skills, agents, hooks) as `vendor --standalone` and make onboarding run it by default. Add two vendored human-only skills so the gates exist without the mod. Rejected: v6-style `/scaffold` with profiles and SKUs; too much machinery for the same copy.

## Design
vendor.ts writes the skills; hooks.ts `runsOwnHooks` makes the plugin's hooks step aside when the project registers its own; register.ts skips approve/waive when the repo ships them; sdlc.ts splits a single quoted argument string.

## Contracts
- add `vendor --standalone`

## Global Constraints
- harness at most 5000 lines, scripts at most 500, skills at most 60 (size.spec.ts)
- red runs go through `sdlc.ts run --expect-fail`

## Files
- scripts/vendor.ts
- scripts/hooks.ts
- scripts/sdlc.ts
- scripts/core.ts
- hooks/register.ts
- skills/onboard/SKILL.md
- templates/settings.json
- scripts/vendor.spec.ts
- tests/register.test.ts
- README.md
- DESIGN.md

## Slices
### Task 1: standalone vendor and human-only gates
Goal: vendor --standalone, the approve/waive skills, the plugin stepping aside, the portable settings template, standalone onboarding. Tests: vendor.spec.ts (4 new), register.test.ts (1 new). Fast test: `node --disable-warning=ExperimentalWarning --test scripts/vendor.spec.ts`.

## Verification
- `npm run typecheck`
- `node --disable-warning=ExperimentalWarning --test scripts/*.spec.ts`

## Risks & rollback
Revert the commit; already-vendored repos keep working, because `--cloud` is unchanged.
