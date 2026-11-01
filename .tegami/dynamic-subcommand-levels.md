---
packages:
  'bash-gate': patch
---

### A subcommand only known at run time may match a rule at every level under it

`git $x stash drop` no longer escapes `deny('git stash drop')`: a rule naming two subcommand levels may match, so it asks.
