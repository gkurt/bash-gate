---
packages:
  'bash-gate': patch
---

### env's lone `-` is `-i` only right after its options

`env -- X=1 - cmd` runs a program named `-`, as GNU's env reads `-` as `-i` only where its options end. The analysis
took it as `-i` after the assignment too, and predicted `cmd`.
