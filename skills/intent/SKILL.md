---
name: intent
description: Capture an idea as an intent file in the inbox (.sdlc/intent/), in the originator's own words, before any change exists. For product owners and anyone with an idea; no git or code knowledge needed. Use when someone describes a problem or an idea to build, not a task to start now.
argument-hint: '"<the idea, in your own words>"'
effort: medium
allowed-tools: Read, Write, Glob, AskUserQuestion
---
# Capture an intent

Idea: $ARGUMENTS

1. **Listen first.** Restate the idea in two lines. Then ask what an analyst would, at most three questions in one AskUserQuestion: who is affected, what better looks like (how we will know), and what is out of scope or constrained (data, security, existing systems). Skip any the idea already answers.
2. **Write** `.sdlc/intent/<kebab-name>.md` (lowercase letters, digits and hyphens; check with Glob that the name is free), at most 40 lines, in the originator's words:

   ```
   ---
   status: draft
   author: <name and role>
   created: <today, YYYY-MM-DD>
   ---
   # Intent: <title>

   ## Problem
   ## Proposed outcome
   ## Affected users and systems
   ## Constraints
   ## Open questions
   ```

   Add `type:` and `tier:` to the frontmatter only if the originator knows them; otherwise the engineer or the rig-spec workflow classifies the idea.
3. **Read it back.** Show the file and ask the originator to correct anything misunderstood; edit until they agree.
4. **Hand over.** It is a draft. The product owner accepts it by setting `status: accepted` and merging it to the trunk in a pull request the inbox's code owners review. With the rig-spec workflow installed, that merge opens a pull request with intent.md and design.md; otherwise an engineer runs `/rig:start .sdlc/intent/<kebab-name>.md`.

End with: `Next: open a pull request with .sdlc/intent/<kebab-name>.md (or ask an engineer to)`.
