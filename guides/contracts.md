---
name: contracts
paths: @contracts
why: a contract rename that passes locally can silently break consumers in other repos (the discount_rate pattern)
---
# Contract rules (read before editing API, schema or migration files)

## Iron rules
1. **Never rename or remove in place.** Expand, migrate, contract: add the new name, move every consumer, remove the old name later.
2. **Know your consumers.** List the change in plan `## Contracts` (``- rename `a` → `b` ``). `sdlc.ts check --at plan` finds the consumers, and the person approves the impact.
3. **Additive first.** New optional fields and endpoints are safe; required fields, type changes and removals are breaking.
4. **Version breaking changes.** A breaking API change gets a new version or a deprecation window, never a silent swap.
5. **Say whether a data migration is reversible**, in `## Risks & rollback`, with the backfill plan.
6. **Update every consumer in the same change.** Consumer files go in plan `## Files` as `../<repo>/...`; each consumer's tests run at verify and ship.
7. **Document the contract where it lives.** Schema comments, OpenAPI descriptions and the changelog change with it.

## Rationalizations
| Thought | Reality |
|---|---|
| "Nobody else uses this field" | The sensor greps the consumers. Let it decide. |
| "Our tests pass" | Your tests don't run in the consumer's repo. |
| "It's just a rename" | Renames are the most common silent break. |
