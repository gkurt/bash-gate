---
packages:
  'bash-gate': patch
---

### `set` and `shopt` read their options as Bash does

`set -eo posix` and `shopt -so posix` turn POSIX mode on, and with it aliases, which was missed: `ls` defined as
`rm -rf /` after either was allowed. Options end at the first word that isn't one (`set x -o posix` sets positional
parameters), and `shopt` with an option it doesn't know, or with both `-s` and `-u`, changes nothing.
