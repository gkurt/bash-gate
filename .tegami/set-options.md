---
packages:
  'bash-gate': patch
---

### `set` and `shopt` read their options as Bash does

`set -eo posix`, `set -o -o posix` and `shopt -so posix` turn POSIX mode on, and with it aliases, which was missed:
`ls` defined as `rm -rf /` after any of them was allowed. Options end at the first word that isn't one (`set x -o
posix` sets positional parameters), and a bad letter or option name anywhere, or `shopt` with both `-s` and `-u`,
changes nothing.
