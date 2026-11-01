---
packages:
  'bash-gate': patch
---

### While an exec is checked, the rest of the supervised tree is stopped

Nothing in the tree can change the exec's arguments between the check and the kernel's copy of them.

### A clone with `CLONE_UNTRACED` fails under the supervisor

Its child would be no tracee: the supervisor couldn't stop it, and the run could end while it still ran.
