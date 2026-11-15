---
packages:
  'bash-gate': patch
---

### A NUL in `$'…'` ends it past a backslash and newline

`$'/\c a\`, a newline, then `b'` is `/` in Bash: `\c ` is a NUL, which ends the string. The analysis decoded the text
on either side of the backslash and newline apart, so it read `/` with a backslash, a newline and `b`, and
`rm -rf` with it asked instead of being denied.
