# v3 notes: DeepWiki-style wiki and learning loops

Both were built, then removed in v0.4.x to keep the harness lean (`5b9cb86`; the specs and plans are in history before `02a9688`). This note says what to bring back, in what shape, and what must be true first.

## Why they went

- **Wiki:** about 2,700 lines (a fifth of the repo) and the least proven. The CI workflow never ran on GitHub, it was never used on a large real repo, and computed edges covered only JS/TS and Python.
- **Learn:** about 520 lines that could not fire. Promotion needs 10 shipped changes, and this repo had one.

## v3 rule: not in core

Core stays the lifecycle, gates and sensors. Each of these returns as an **optional plugin** (`rig-wiki`, `rig-learn`) that reads core's evidence and adds no imports to `check`, `hooks` or `sdlc`. This time the wiki was wired into the checker, the session-start hook and the sensor list, which is what made it expensive to carry.

## 1. DeepWiki-style wiki

Goal: a repo map a new engineer or agent can ask questions of, kept fresh without a person.

Keep from v0.4.x:
- **Computed layer plus prose layer.** Diagrams, file, entry-point, dependency and test tables come from real imports at zero tokens, inside `<!-- rig:gen:NAME -->` blocks. A small model writes only prose, and wiki text is treated as untrusted data.
- **Citations enforced.** A page needs `path:line` references, checked by script.
- **Privilege split in CI.** A read-only job runs the model with no shell or network; a write-token job runs no model and refuses symlinks and manifest changes.
- **Zero-token ranked search** underneath `ask`.

Do differently:
- **Run the workflow on GitHub first**, before adding features. Its first-run checklist (agent mode on `push`, `--allowedTools` confinement headless, artifact semantics) was never verified.
- **Use a real parser** (tree-sitter or the language's own tooling) rather than a per-language regex table, and resolve aliases and monorepo packages.
- **Cache the graph.** Rebuilding it cost about 1.3 s on 5,000 files at every commit.
- **Add "why" from evidence.** Join `.sdlc/changes/<slug>/` (intent, design, review findings) to the files they touched, so the wiki can say why code looks as it does. This is the part a plain code index cannot do.
- **Keep it out of the commit path.** Warn in CI, not at `pre-commit`.

Entry test: on one real repo of 50k+ lines, `ask` answers 10 questions the maintainer chose, with correct citations, and a refresh PR opens by itself.

## 2. Learning and self-improvement (RSI-style) loops

Goal: the harness improves from its own evidence, without letting the improver weaken the judge.

Keep from v0.5:
- **Evidence in, proposals out.** Mine review findings, blocked events and waiver churn across shipped changes. A pattern needs at least 2 distinct changes.
- **Replay gate.** A proposed rule is promotable only if it fires on the stored diff of a change it came from and on no shipped change without that finding.
- **Human-only promotion**, and the learner lives in protected paths, so the improver cannot edit the gate that judges it. This is the line between a learning loop and a loop that games itself.
- **Frozen model, zero tokens** for v1.

Add for v3:
- **A model proposer** behind the same replay gate, to suggest edits to skill text and templates and not only regex rules.
- **Close the loop on outcomes.** Record whether a promoted rule later fires usefully or gets waived, and retire rules that churn.
- **Gate-friction signals.** Approvals store a digest only today; log time-to-approve and re-approvals.
- **A held-out set.** Keep some shipped changes out of replay so a rule cannot overfit.
- **A cost ceiling and a kill switch** per loop run.

Entry test: at least 30 shipped changes of real evidence, then show one promoted rule that measurably lowers a recurring finding on later changes.

## Open design questions

- Should `learn` also tune `sensors.json` thresholds, or stay advisory? Today it was advisory only.
- Is the wiki one artifact for humans and agents, or should agents get a smaller, denser index?
- Where do these plugins keep state without touching `.sdlc/` evidence files?
