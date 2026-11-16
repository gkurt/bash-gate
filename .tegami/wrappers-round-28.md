---
packages:
  'bash-gate': patch
---

### Namerefs, compgen and file follow the code and writes they reach

- `declare -n r='a[$(cmd)]'` (and `local -n`) walks the target's subscript, which every read of `r` runs; a target only
  known at run time is a finding.
- `compgen -W` expands its word list, substitutions and all, and `compgen -F f` calls `f` in the shell itself.
- `file` with an argument only known at run time (`xargs file`, `file $a`) may be `-C`, which writes compiled magic in
  the working directory.
