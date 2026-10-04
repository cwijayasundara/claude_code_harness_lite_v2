# REVIEW.md: how changes are reviewed here

Read by sdlc's pr-review node and by the sdlc-review workflow. Edit it to match your team.

## Review passes
1. **Correctness:** behaviour matches the spec's B-numbers; edge cases the intent names are handled.
2. **Security:** input validation, authn/authz on every new endpoint, no secrets or PII in logs or errors.
3. **Contracts:** every API, schema or event change is listed in plan.md `## Contracts` and is additive or follows expand–migrate–contract.
4. **Design:** one responsibility per unit; dependencies point inward; no abstraction with a single implementation.
5. **Tests:** every new behaviour is pinned by a test that would fail without the change.

## What counts as Important (critical or high)
- Wrong behaviour, data loss, a security hole, a contract change the plan did not announce, or a missing test for a B-number.

## Nits (medium or lower; never block)
- Naming, comments, small duplication, style a linter does not catch.

## Exclusions
- Generated files, lockfiles, vendored `.sdlc/bin/**`, and anything CI's sdlc-check already enforces.
