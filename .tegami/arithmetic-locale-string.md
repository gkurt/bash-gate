---
packages:
  'bash-gate': patch
---

### A `$"…"` string in arithmetic is unknown syntax

Bash translates `$"…"` as it parses arithmetic, and what that leaves with the expansions around it, read again as a
subscript, can run code (`(( a[$"$"$@""(cmd)] = 1 ))`): it's an `unknown-syntax` finding.
