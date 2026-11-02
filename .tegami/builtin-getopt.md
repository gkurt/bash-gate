---
packages:
  'bash-gate': patch
---

### `read`, `mapfile`, `compgen` and `complete` read their options as Bash does

Letters may share a word and a value may be attached: `mapfile -tC'rm -rf /' -c1 a` runs `rm` as its callback, which
was missed. Options end at the first word that isn't one.
