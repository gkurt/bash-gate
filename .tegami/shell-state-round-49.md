---
packages:
  'bash-gate': patch
---

### A nameref or attribute on `_`, `PWD` or `OLDPWD`, or an attribute through a nameref, is a finding

Bash assigns `_`, `PWD` and `OLDPWD` itself, through a nameref and with the attributes they have. These were allowed and changed what ran:

- `declare -n _=x` makes each command's last word `x`'s value: `x=ls; declare -n _=x; : rm; $x -f f` runs `rm`.
- `declare -n OLDPWD=x` lets `cd` assign `x`.
- `declare -i _` evaluates each last word as arithmetic, command substitutions in subscripts included.
- `declare -l PWD` lowers what `~+` reads.

An attribute given to a nameref (`declare -n r=v; declare -i r`) goes to the variable it names. All of these are now `sensitive-variable` findings.
