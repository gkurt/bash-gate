---
packages:
  'bash-gate': patch
---

### A path through a symlink's `..` or `/proc` is never the system program or the file predicted

- `/proc/self/cwd/../../usr/bin/ls` or `link/../../usr/bin/ls` folds to `/usr/bin/ls` as text, while the kernel leaves
  from where the symlink leads: such a program path is no system path (`exec:file`), and under the supervisor no exec
  by it is covered, nor is a wrapper's shell started by it.
