---
packages:
  'bash-gate': patch
---

### `$'…'` in a quoted default or a here-document, and a variable's name across a line continuation

In a double-quoted `"${y:-$'…'}"` Bash decodes the `$'…'` and expands what it holds, so `"${y:-$'\x24(rm -rf /)'}"`
runs `rm`; in a here-document `$'` is no quoting at all, and the substitution after it runs. A subscript expanded again
decodes `$'…'` too. And a line continuation is gone before Bash reads a word, so `$x\` then a newline and `r` is `$xr`.
