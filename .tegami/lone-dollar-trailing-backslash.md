---
packages:
  'bash-gate': patch
---

### A lone `$` keeps a word whole, and a backslash ending the code is a parse error

Bash doesn't split a word with a `$` in it that starts no expansion: with `x='a b'`, `$x-$` is the one word `a b-$`.
A backslash that ends the code is kept by Bash, or dropped after a quoted string over several lines, so it's counted
as a parse error.
