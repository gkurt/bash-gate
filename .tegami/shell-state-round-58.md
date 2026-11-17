---
packages:
  'bash-gate': patch
---

### Case attributes as Bash's declare sets them, and builtins turned off on one path only

- **`declare +X`:** a `+u`, `+l` or `+c` takes away only its own letter, as Bash does, and each `-X` takes the other two away. `declare -u o; declare +l o; o=-b; git checkout $o feature` runs `git checkout -B`, and now reads as it.
- **`enable -n` on one path:** a builtin turned off in one branch only (`[ -t 0 ] && enable -n cd`) may run as the builtin or the program afterwards, and both are followed. It was read as off for certain, so `cd /etc` after it didn't move the tracked working directory.
