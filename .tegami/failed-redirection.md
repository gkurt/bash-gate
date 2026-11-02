---
packages:
  'bash-gate': patch
---

### A command whose redirection may fail may not run

Bash runs none of a command, or a `{ …; }` group, when it can't open one of its files, so what it would change may
stay as it was: `alias rm=true <missing` defines nothing, and `rm -rf /` after it was read as `true -rf /`.
