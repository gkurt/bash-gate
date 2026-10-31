---
packages:
  'bash-gate': patch
---

### Relative globs match from the starting `cwd`, so `recommended` allows writes inside it

With `cwd: '/repo'`, `echo hi > out.txt` was asked about as a write outside the working directory. Relative globs now match paths from an absolute starting `cwd` (and its real path), and `recommended` asks about `..`, `../**` and `~/**` instead of `/**`. Without a starting `cwd`, an absolute path may match a deny or ask rule's relative glob.
