---
name: policy-security
description: The security policy for this repository. Apply it whenever a spec, plan, design or change touches an endpoint, authentication, authorization, input handling, logging, secrets or personal data.
owner: <the team or person who owns this policy>
source: <link to the written policy this skill follows>
---
# Security policy

Applies to every spec, plan, design and change here. Where a change cannot meet a rule, do not work around it: record a `## Concerns` bullet naming this policy and its owner.

1. **Authentication:** every new endpoint requires the existing authentication; no anonymous route except health checks.
2. **Authorization:** every read or write of another user's data checks that the caller may do it.
3. **Input:** validate request bodies and parameters against their schema and reject unknown fields.
4. **Secrets and personal data:** never in code, logs, error messages or test fixtures.
5. **Audit:** every state-changing operation records who did what, to what, and when.

Edit this file to match your written policy, set `owner` and `source`, and have the owner approve changes to it like code.
