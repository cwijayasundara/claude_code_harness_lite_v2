---
name: build
description: Build an approved plan slice by slice. Each slice loops implementer → sensors → reviewer until no critical or high finding remains, within the ratchet's cap; the script counts rounds and decides.
argument-hint: <slug>
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts *), Bash(git checkout*), Bash(git status*), Bash(git diff*), Bash(git log*), Bash(git rev-parse*), Read, Write, Edit, Glob, Grep, Agent, Skill
---
# Build $0

Run each sdlc.ts command as its own Bash call (no `cd`, pipes, redirects, `&&` or variables); read files with Read and Grep; one-line commit messages.

**Models:** read `routes` from `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json` and pass that role's `model` and `effort` on every launch: `rig:researcher` (researcher), `rig:architect` (architect), `rig:implementer` (implementer), `rig:reviewer` (`slice-review` in build, `reviewer` elsewhere). A `main` route means draft it in this thread.

**Subagents:** run them in the foreground and wait; never end your turn while one is running.

Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json`. Continue only if `verdict` is `continue` and `node` is `build`; otherwise show the reason and stop.

1. If on the trunk: `git checkout -b sdlc/$0`. If `status` warns that HEAD is on another change's branch, run the command it prints first.
2. Read `design.md` (or `plan.md` when there is no design.md). Slices are its `### Task N:` headings; a plan without them is one slice, `1`. `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts ratchet show $0` lists the slices already done; skip those.
3. **For each remaining slice, in order** (parallel, at most 3, only when their `Files:` do not overlap):
   1. **Implement.** Tier M with ≤ 3 slices and ≤ 8 files: do it yourself, test first: write the failing test, record the red run with `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts run --expect-fail -- "<test command>"`, implement inside `## Files`, run the targeted tests quietly. Otherwise (tier S included, which runs on Haiku) launch one `rig:implementer` with a brief of ≤ 60 lines: slice goal, owned files, interface sketch, acceptance tests with B-numbers, the fast test command and the guides that apply.
   2. **Verify the slice.** Tier S and M: no model review. Run the slice's declared fast test command through the recorder (`node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts run -- "<command>"`), then `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts ratchet record $0 build --slice N --checks`. The script checks that the run is green on the current tree, no sensor blocks and every changed file is in `## Files`; it prints `done`, or exits with what to fix (fix it, run the recorder again; never edit `ratchet.json`). The script commits the slice on `sdlc/$0` itself (only that slice's planned files); never commit slices yourself.
      Tier L: launch `rig:reviewer` with `mode: slice`, the change folder, the slice number and the diff range for that slice.
   3. **Record (tier L).** Write the reply (a `verdict:` line and findings in the line format) to `.sdlc/changes/$0/review-slice-N.md` with the Write tool, then run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts ratchet record $0 build --slice N --from .sdlc/changes/$0/review-slice-N.md`. `--slice` is required when plan.md has more than one slice. It refuses a reply without a verdict; `changes-needed` needs a critical or high finding. It prints `continue`, `done` or `blocked`; on `done` the script commits the slice on `sdlc/$0` itself (only that slice's planned files), so never commit slices yourself:
      - `done`: next slice.
      - `continue`: send only the critical and high findings to the same implementer, then run the slice review again.
      - `blocked`: stop. Show the reason; the person decides (`/rig-approve $0 budget` lifts a budget, stall or cap block).
4. Never edit `ratchet.json`, `events.jsonl` or `plan.md` to get past a round. Track progress in `.sdlc/STATE.md` only.

End with: `Next: <command from node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts next $0 --json>`. If a person is driving with `/rig-run`, stop here. Otherwise keep going in this turn: run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts skill next` and follow it.
