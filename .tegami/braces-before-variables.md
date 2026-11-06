---
packages:
  'bash-gate': patch
---

### Braces expand before variables

Bash expands `$x{a,b}` to `$xa $xb`, so the variable's name runs into each alternative; it was read as `$x` followed
by `a` or `b`. `x=./build; xr=/; rm -rf $x{r,}` removes `/`.
