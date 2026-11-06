---
packages:
  'bash-gate': patch
---

### An assignment removes the quotes in a glob, and an unquoted value is a pattern

`x=a['q']` stores `a[q]`, as in Bash, so `x=[';rm -rf /;']; eval "$x"` runs `rm`; the quotes were kept. A known
value used unquoted is matched against files as a written glob is: `x='*'; cat $x` is a glob, no longer the word `*`.
