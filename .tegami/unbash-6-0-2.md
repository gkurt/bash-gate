---
packages:
  'bash-gate': patch
---

### unbash 6.0.2

`$'…'` stops at its first NUL escape, as in Bash, and `<<` inside `${…}` no longer starts a here-document.
