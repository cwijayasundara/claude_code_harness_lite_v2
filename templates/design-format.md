# Format of spec.md, plan.md and design.md

Followed by the architect, and by the main thread when it drafts a tier S or M plan or design itself.

**spec.md**, at most 150 lines: `## Context` (≤ 5 lines); `## Behaviours`, numbered `B1`, `B2`… as Given / When / Then a test can prove; `## Interfaces` (signatures, endpoints, schemas, events, no implementation); `## Non-functional` (measurable only); `## Out of scope`; `## Open questions`; `## Decisions`. Stay within the intent; hardening its risks do not call for goes to Out of scope.

**plan.md** and **design.md** (same format; design.md is the feature and greenfield document, approved together with intent.md), at most 120 lines, **no implementation code** (sketches ≤ 10 lines, signatures only):
- `## Approach`: ≤ 10 lines, including the rejected alternative and why.
- `## Design`: ≤ 5 lines. Modules and the direction of dependencies (domain ← application ← adapters). Every new unit has one responsibility; say where each is injected. No abstraction with a single implementation.
- `## Contracts`: one line per contract identifier added, renamed or removed: ``- add `x` ``, ``- rename `a` → `b` ``, ``- remove `a` ``. Write `none` if none. Renames follow expand–migrate–contract (guides/contracts.md).
- `## Global Constraints`: one line each for binding values every slice must honour, the guides that apply, and "red runs go through `sdlc.ts run --expect-fail`".
- `## Files`: one `- path/or/glob` per line, tests included. This is the ownership contract. Consumer repo files are `../<repo>/...` globs.
- `## Slices`: thin vertical slices, each a `### Task N: <name>` heading (N from 1) with its goal, files, interface sketch, acceptance tests naming the B-numbers they prove, and its fast test command.
- `## Verification`: one backticked command per bullet, starting the bullet (``- `npm test` ``); notes only after the command. Include lint and type-check from `.sdlc/sensors.json` and each affected consumer's test command. Nothing else in the section: put "none configured" and other notes under Risks. When the spec has a UI, a performance NFR or a running service, include the `e2e`, `bench` or `smoke` command from `.sdlc/sensors.json`.
- `## Risks & rollback`.

Order slices by change type: greenfield, a walking skeleton first; refactor, characterization tests first; migration, inventory, then a pilot unit, then fan-out. Prefer the fewest slices that keep each one testable.
