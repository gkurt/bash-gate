---
packages:
  'bash-gate': patch
---

### `set` reads its options as Bash does

`set -eo posix` turns POSIX mode on, and with it aliases, which was missed: `ls` defined as `rm -rf /` after it was
allowed. Options end at the first word that isn't one, so `set x -o posix` sets positional parameters.
