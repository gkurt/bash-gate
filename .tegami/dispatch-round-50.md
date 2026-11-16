---
packages:
  'bash-gate': patch
---

### git's patch and edit modes open the editor, and biome with a word only known at run time may write or delete

- These open the editor (`exec:arbitrary`), which `vi` makes scriptable from the script's input:
  - `git add -p`, `-i` and `-e`;
  - `git commit -p` and `--interactive`;
  - `git stash -p`, and `stash push -p` or `save -p`.
- A biome command only known at run time is now `exec:arbitrary`. Before, it had no effects at all: `biome "$(echo format)" --write ../x` and `xargs biome` were allowed, although `format --write` rewrites files and `clean` deletes.
- Under `check`, `lint`, `format` and `migrate`, a word that may be `--write` counts as one.
