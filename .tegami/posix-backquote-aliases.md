---
packages:
  'bash-gate': patch
---

### Backquotes have their run-time aliases in POSIX mode

Bash parses backquotes as they run, like a process substitution, so in POSIX mode they get the aliases defined then,
even inside a `$(…)` that has its line's: `{ alias ls="rm -rf /"; x=$(echo \`ls\`); }`on separate lines runs`rm`.
