---
packages:
  'bash-gate': patch
---

### uutils' `env` reads every lone `-` as `-i`, and the next word's alias is expanded before an operator

- GNU's `env` reads a lone `-` as `-i` only right after its options; after an assignment it's the command. uutils'
  `env` (Ubuntu's since 25.10) reads every `-` among the assignments as `-i`, so `env -- X=1 - rm -rf /` runs `rm` there.
  Both readings are walked.
- After an alias ending in a blank, Bash checks the first word of the next word's alias text for an alias too. The
  analysis skipped this when an operator followed that first word: `alias l='r&& x'` after `sudo ` ran `r`'s text
  unseen.
