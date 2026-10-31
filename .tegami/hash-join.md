---
packages:
  'bash-gate': patch
---

### A name hashed in only some branches, to an unknown path, is a finding

After `if …; then :; else hash -p /bin/cat h; for i in 1; do hash -p /bin/rm h; done; fi`, `h` was taken to be a program named `h`. It's now a `loads-code` finding, which asks.
