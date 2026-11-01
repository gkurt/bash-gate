---
packages:
  'bash-gate': patch
---

### No process under the supervisor holds `CAP_SYS_PTRACE`, root included

With Yama's `ptrace_scope` at 1 or more, a process in the tree can then write only its descendants' memory, so it
can't change the arguments of an exec its parent or a sibling makes after the check.
