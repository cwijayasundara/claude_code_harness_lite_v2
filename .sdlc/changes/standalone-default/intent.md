---
slug: standalone-default
type: feature
tier: M
created: 2026-10-04T06:39:39.737Z
---
# standalone-default

## Problem
An onboarded repo depends on the plugin: teammates and cloud sessions without it get no skills, agents or hooks. The person found this testing shop-app and wants the child repo independent of the plugin, without v6's scaffold machinery.

## Outcome
`/sdlc:onboard` vendors the harness into the repo by default (`vendor --standalone`). The repo then runs skills, agents, hooks and human-only `/sdlc-approve` and `/sdlc-waive` with no plugin. Checked by vendor.spec.ts and register.test.ts, plus live Haiku probes: the person's approval is written, and a model told to approve gets denied.

## Non-goals
Moving artifacts into .claude/ (it is protected, and CI reads the evidence). Cloud-session approval (untested).

## Risks
Security: the human-only gates. The skills are disable-model-invocation, their allowed-tools cover only their own command, $ARGUMENTS is single-quoted, and pre-bash still denies model Bash naming SDLC_HUMAN.

## Decisions
- Q1: standalone by default or opt-in? → standalone by default (person)
