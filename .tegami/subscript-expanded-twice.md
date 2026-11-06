---
packages:
  'bash-gate': patch
---

### An array literal's subscript is expanded twice

Bash expands `a=([$k]=1)`'s subscript, then expands what that leaves again, so `k='$(rm -rf /)'` runs `rm`: what a
known value leaves is walked, and one only known at run time is a `dynamic-script` finding, as it may be any code.
