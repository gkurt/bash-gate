---
packages:
  'bash-gate': patch
---

### A process substitution no longer splits the word it's in

`v=<(f) rm -rf /` runs `rm` with `v` assigned, and `a<(f)` is one argument, as in Bash. The command was taken to be `<(f)`, so the deny rule for `rm` didn't apply and the gate asked instead of denying.
