---
name: engineering
paths: @source
why: agent-written code drifts toward god files, hidden coupling and copy-paste; these are the review findings that keep recurring
---
# Engineering rules (read before editing source)

These are rules, not suggestions. The sensors and the reviewer check them.

## Iron rules
1. **One reason to change.** A function does one thing; a module owns one responsibility. If you need "and" to describe it, split it.
2. **Dependencies point inward.** Domain logic never imports frameworks, I/O, HTTP, databases or the clock. Pass them in.
3. **Inject at the boundary.** Build real implementations in one composition root; everything else receives interfaces or functions.
4. **Reuse before you write.** Search for an existing helper, type or module first. Duplicated logic is a defect.
5. **No speculative abstraction.** No interface with one implementation, no factory for one product, no option nobody passes.
6. **Small and named for intent.** Files under the project's line limit, functions that fit on a screen, names that say what, not how.
7. **Composition over inheritance.** Pass behaviour in rather than subclassing to override it.
8. **Errors are handled or surfaced.** No empty catch and no silent fallback that hides a failure; fail loudly with context.
9. **No hidden state.** No module-level mutable singletons; state lives in an owner you can pass and test.
10. **Match the codebase.** Follow the existing structure, naming and style before your own preferences.

## Rationalizations
| Thought | Reality |
|---|---|
| "It's quicker to add it to this file" | That is how god files are made. Put it where its responsibility lives. |
| "I'll make it generic for later" | Later rarely comes; the abstraction stays. YAGNI. |
| "Importing the DB here is simpler" | Then the domain can't be tested without the DB. Inject it. |
| "This is similar but not the same" | Extract the shared part and parameterize the difference. |
| "The catch is just in case" | A swallowed error is a bug report you will never receive. |
