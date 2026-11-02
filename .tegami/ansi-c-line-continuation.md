---
packages:
  'bash-gate': patch
---

### A backslash and newline in `$'…'` are kept

They're no escape there, so Bash keeps both, where the parser dropped them: `$'a\` and a newline, then `b'`, is three
characters and a newline, not `ab`.
