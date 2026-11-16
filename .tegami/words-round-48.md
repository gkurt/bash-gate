---
packages:
  'bash-gate': patch
---

### A `+` case attribute turns off its letter in either order, and a tilde in an assignment-shaped argument is expanded

- `declare +u -u x=…` no longer upper-cases what it's assigned. Bash turns each letter given with `+` off, whatever the order: `+u -u` leaves the value as it is, and `+u -l` still lower-cases. The analysis upper-cased it, so `declare +u -u o=-c; git $o core.fsmonitor=… status` was allowed although git ran the fsmonitor command.
- A tilde after the `=` or a `:` of an argument shaped like an assignment (`echo a=~/x`, `declare x=a:~/b`) is now only known at run time, because Bash expands it there too.
