---
packages:
  'bash-gate': patch
---

### Sequences with whitespace before a number, and steps past 64 bits

Bash reads a sequence's numbers past the whitespace before them, which an unquoted word holds as `\v` or `\f`:
`$y{\v1..1}` is `$y1`. Such a brace, and one whose step is too big to hold, is only known at run time.
