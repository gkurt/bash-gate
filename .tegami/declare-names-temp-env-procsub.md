---
packages:
  'bash-gate': patch
---

### Declare's bad names, a builtin's temporary environment, and process substitutions in POSIX mode

`declare y!=d` is no name to Bash, which refuses it and leaves `y` as it was. What a builtin or function assigns to a
variable it was given for the call (`z=a read z`) is gone after it unless it went global, so it's only known at run
time. And in POSIX mode a process substitution has the aliases defined when it runs, unlike a command substitution.
