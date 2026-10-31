---
packages:
  'bash-gate': patch
---

### Traps set in a subshell or a child shell see what's defined after them

A trap runs when the shell that set it exits, so it's also walked with that shell's state at its end: `( trap 'f' EXIT; f() { rm -rf /; } )` is denied.
