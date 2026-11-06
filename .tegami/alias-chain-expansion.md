---
packages:
  'bash-gate': patch
---

### A blank-ending alias stops at an unquoted expansion, and a backslash in a default's inner quotes

After an alias whose text ends in a blank, Bash checks the next words for aliases past quoted ones, but not past one
with an unquoted expansion (`$x`, `$(…)`, `<(…)`). And in a default's inner quotes, Bash drops a backslash before what
it doesn't escape in double quotes: `"${v:-"$\(rm -rf /)"}"` runs `rm`.
