---
packages:
  'bash-gate': patch
---

### A function is read in the code it was defined in, wherever it's called from

A function called from a trap or `eval` was read against the caller's code, so `trap f EXIT; f() { x=$(( '$(rm -rf /)'
)); }` missed `rm`. A `declare` word only known at run time that may be an option leaves the variables it names
unknown, as Bash may reject it. And braces Bash expands differently from the parser are a parse error, as they may
multiply the substitutions in the word.
