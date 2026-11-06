---
packages:
  'bash-gate': patch
---

### `$'…'` in a default inside `"$(…)"`, and an empty variable named across a line continuation

In a command substitution inside double quotes, Bash decodes a `$'…'` in a `${…}` operand and expands what it holds, so
`"$(echo ${y:-$'\x24(rm -rf /)'})"` runs `rm`. And an empty variable whose name runs across a line continuation is no
word, where it was read as an empty one.
