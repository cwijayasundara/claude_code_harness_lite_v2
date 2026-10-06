---
name: testing
paths: @tests
why: agent-written tests often pass without proving anything, and tests are the contract humans review instead of the code
---
# Testing rules (read before editing tests)

## Iron rules
1. **Red first.** Write the test and run it with `sdlc.ts run --expect-fail -- "<cmd>"`. See it fail for the right reason before writing code. Ship recomputes this against the base.
2. **Test behaviour, not implementation.** Assert on outputs, state and observable effects through the public interface, never on private calls.
3. **One reason to fail.** Each test pins one behaviour and its name says which, with the B-number: `B3 rejects an empty key`.
4. **Edges and errors are behaviours.** Empty, boundary, malformed, duplicate and failure paths each get a case when the intent covers them.
5. **Never weaken a test to get green.** No skip, only, xfail, deleted assertions or lowered thresholds. Fix the code. The sensors block these.
6. **Fake only at the boundary.** Use real objects inside your code; fake I/O, network, clock and randomness at the edge.
7. **Deterministic.** No sleeps, wall-clock time, network or test-order dependence; inject the clock and seeds.
8. **Readable as a spec.** Arrange, act, assert; literal inputs and expected values; no logic in tests.
9. **API tests use the real surface.** Call the handler or HTTP endpoint and assert on status and body, including the error statuses the spec names.
10. **Smoke and performance are declared commands.** `smoke` and `bench` in `.sdlc/sensors.json` `full`: smoke starts the app, hits a health check and stops under a timeout; bench exits non-zero when it misses the spec's `## Non-functional` number.

## Rationalizations
| Thought | Reality |
|---|---|
| "I'll write the test after" | Then it is shaped by the code and passes by construction. |
| "This assertion is flaky, drop it" | Find the nondeterminism and inject it. |
| "Mocking the internals is easier" | Then every refactor breaks tests that should still pass. |
| "Coverage is high enough" | Coverage counts lines run, not behaviours proven. |
