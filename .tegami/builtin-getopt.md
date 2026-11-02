---
packages:
  'bash-gate': patch
---

### `read`, `mapfile`, `compgen`, `complete` and `enable` read their options as Bash does

Letters may share a word and a value may be attached: `mapfile -tC'rm -rf /' -c1 a` runs `rm` as its callback, which
was missed. Options end at the first word that isn't one. An `enable` argument only known at run time may be `-n` or
any builtin's name, so it's a `dynamic-command` finding.
