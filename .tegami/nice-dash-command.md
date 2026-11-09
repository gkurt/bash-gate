---
packages:
  'bash-gate': patch
---

### A command after `nice --` that starts with a dash is unknown

uutils' `nice` rewrites `-n N` into `-nN` even after `--`, so `nice -- -n 1 cmd` runs `-n1` there and `-n` in GNU's.
