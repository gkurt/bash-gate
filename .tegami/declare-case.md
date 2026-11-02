---
packages:
  'bash-gate': patch
---

### `declare -u`, `-l` and `-c` change the case of what a variable is assigned

`declare -l v; v=RM; $v -rf /` runs `rm`, and was read as `RM`. A `declare`, `local`, `export` or `readonly` with an
option Bash doesn't know changes nothing.
