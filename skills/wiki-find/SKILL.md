---
name: wiki-find
description: Locate files, symbols and wiki pages for a feature or term using the code wiki before falling back to Glob/Grep.
allowed-tools: Bash(node:*), Read
---
Run `node --disable-warning=ExperimentalWarning ${CLAUDE_PLUGIN_ROOT}/code_wiki/wiki.ts find <terms>`. Each line is `kind name file page [(stale)]`. Treat results as pointers: open the file to confirm. If a hit is stale or nothing matches, fall back to Glob/Grep.
