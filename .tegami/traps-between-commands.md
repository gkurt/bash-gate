---
packages:
  'bash-gate': patch
---

### Trap actions and prompt strings are walked between every two commands

Once set, they're walked at each point they may run, with the state there, and what they change carries on: `f() { :; }; trap f ERR; f() { rm -rf /; }; false; f() { :; }` and `x=ls; trap 'x=rm' DEBUG; $x -rf /` no longer hide `rm`. `trap -- 'action' SIG` is walked, and `trap - SIG` resets it.
