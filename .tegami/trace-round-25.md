---
packages:
  'bash-gate': patch
---

### The trace layer reads relative paths where they're run, and keeps paths meaning what they mean

- The supervisor reads a relative exec path from the process's own working directory, so `cd d && ./s` is `d/s`, and
  is judged against what the analysis predicted there.
- The run's Bash is the system's, not one an empty or relative `PATH` entry finds first.
- A new user or mount namespace, `chroot`, `mount`, `pivot_root`, `setns` and the new mount API fail with EPERM: no
  process in the tree changes what a path names or gains capabilities over the others (`unshare -r`).
- A shell a wrapper starts is covered only when it runs the code the wrapper was given; arguments that aren't UTF-8 only
  by a finding that hides code.
- `source` of a file the analysis doesn't see, and `mapfile -C`'s callback, leave the working directory unknown.
