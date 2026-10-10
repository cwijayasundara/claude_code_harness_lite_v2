## Verification
- Red first, per slice: `sdlc.ts run --expect-fail -- "node --test test/service.test.js test/http.test.js"`. S3 adds `test/clock.test.js` to this command.
- Contract impact: `sdlc.ts check --at plan`. There are no known consumer repos and no `../` globs.
- Full suite: `npm test`, which runs `node --test`.
- Lint and type-check: none configured. `.rig/sensors.json` only defines `npm test` for fast and full.

