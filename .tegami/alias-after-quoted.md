---
packages:
  'bash-gate': patch
---

### An alias ending in a blank reaches past quoted words

Bash doesn't expand a quoted word after it, but still checks the next one: with `alias s='sudo ' r='rm -rf /'`,
`s \env r` runs `sudo env rm -rf /`.
