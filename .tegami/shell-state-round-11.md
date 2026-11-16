---
packages:
  'bash-gate': patch
---

### `local -`, `local -g`, elements, `declare -p` and `cd -P`

- `local -` puts POSIX mode, `expand_aliases` and the other `set` options back when the function returns, so
  aliases and special builtins after it are read as Bash reads them.
- `local -g` assigns the global, not a local.
- `unset 'x[0]'` unsets a plain variable, and an element assigned with `declare`, `local` or `export` (which refuses
  it) leaves the variable's value only known at run time; so do `declare -a`, `-A` and a quoted `(…)` value, which
  may be a list.
- `declare -p` and `-F` assign nothing, and make no local in a function.
- After `cd -P` (or under `set -P`), the working directory is where symlinks lead, read from the files, or unknown
  without them; the last of `-L` and `-P` counts.
- `read -E` (Bash 5.3) assigns its names.
