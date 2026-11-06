---
packages:
  'bash-gate': patch
---

### An alias named across a line continuation, declare's unseen braces, and where a lone `$` stops splitting

A line continuation is gone before Bash looks for an alias, so `l\` and a newline then `s` runs the alias `ls`. A
`declare` argument whose braces Bash expands but the parser didn't see (`d=(a){b,c}`) is only known at run time. And a
lone `$` keeps a word from splitting only when no unquoted expansion comes after it: `$x$/$x` still splits.
