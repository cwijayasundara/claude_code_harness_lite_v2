---
name: build
description: Build an approved plan slice by slice. Each slice loops implementer → sensors → reviewer until no critical or high finding remains, within the ratchet's cap; the script counts rounds and decides.
argument-hint: <slug>
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Bash(git checkout*), Bash(git status*), Bash(git diff*), Bash(git log*), Bash(git rev-parse*), Read, Write, Edit, Glob, Grep, Agent, Skill
---
# Build $0

Run each sdlc.ts command as its own Bash call (no `cd`, pipes, redirects, `&&` or variables); read files with Read and Grep; one-line commit messages.

**Subagents:** run them in the foreground and wait; never end your turn while one is running.

Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json`. Continue only if `verdict` is `continue` and `node` is `build`; otherwise show the reason and stop.

1. If on the trunk: `git checkout -b sdlc/$0`. If `status` warns that HEAD is on another change's branch, run the command it prints first.
2. Read `design.md` (or `plan.md` when there is no design.md). Slices are its `### Task N:` headings; a plan without them is one slice, `1`. `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts ratchet show $0` lists the slices already done; skip those.
3. **For each remaining slice, in order** (parallel, at most 3, only when their `Files:` do not overlap):
   1. **Implement.** Tier S, and tier M with ≤ 3 slices and ≤ 8 files: do it yourself, test first: write the failing test, record the red run with `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts run --expect-fail -- "<test command>"`, implement inside `## Files`, run the targeted tests quietly. Otherwise launch one `rig:implementer` with a brief of ≤ 60 lines: slice goal, owned files, interface sketch, acceptance tests with B-numbers, the fast test command and the guides that apply.
   2. **Review the slice.** Tier L: launch `rig:reviewer` with `mode: slice`, the change folder, the slice number and the diff range for that slice. Tier S and M: run the built-in `code-review` skill at `medium` on the slice's diff and restate each finding in the reviewer's line format.
   3. **Record.** Write the reviewer's reply (it must hold a `verdict:` line and any findings in the line format) to `.sdlc/changes/$0/review-slice-N.md` with the Write tool, then run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts ratchet record $0 build --slice N --from .sdlc/changes/$0/review-slice-N.md`. `--slice` is required when plan.md has more than one slice. It refuses a reply without an explicit verdict; `changes-needed` needs at least one critical or high finding. It prints `continue`, `done` or `blocked`:
      - `done`: next slice.
      - `continue`: send only the critical and high findings to the same implementer (or fix them yourself for small builds), then go back to sub-step 3.2 (Review the slice).
      - `blocked`: stop. Show the reason; the person decides (`/rig-approve $0 budget` lifts a budget, stall or cap block).
4. Never edit `ratchet.json`, `events.jsonl` or `plan.md` to get past a round. Track progress in `.sdlc/STATE.md` only.

End with: `Next: <command from node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json>`. If a person is driving with `/rig-run`, stop here. Otherwise keep going in this turn: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it.
