---
packages:
  'bash-gate': patch
---

### An alias whose text is only known at run time counts as unseen code

`covers` accounted for one program with one word in its place, but such an alias can run anything: arguments, other
commands, wrappers.
