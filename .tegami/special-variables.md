---
packages:
  'bash-gate': patch
---

### Bash's own variables, namerefs and `command_not_found_handle` are followed

`BASH_ALIASES` and `BASH_CMDS` change the alias and `hash` tables, and a nameref (`declare -n`) or a variable named only
at run time may assign any variable: each was allowed before. Variables Bash sets itself (`RANDOM`, `PWD`,
`PIPESTATUS`, `_`…) are unknown whatever was assigned. `${x:=v}`, `printf -vNAME`, `wait -p`, `compgen -V`,
`exec {fd}>`, `coproc` and `select` assign, `unset` may remove a function, and `unset PATH`, `local PATH` and
`EXECIGNORE` are `sensitive-variable` findings. `command_not_found_handle` is walked for each program, and `fc`,
`set -H` and `history -w` are followed as running or writing history.
