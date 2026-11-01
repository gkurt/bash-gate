---
packages:
  'bash-gate': patch
---

### An assignment of a process substitution replaces the variable's value

`x=ls; x=<(:); $x` kept `x` as `ls`; it's now only known at run time, as in Bash, where it's a `/dev/fd` path.
