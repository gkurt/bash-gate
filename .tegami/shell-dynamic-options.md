---
packages:
  'bash-gate': patch
---

### A shell option only known at run time may be `-c`

`bash $x 'rm -rf /'` runs `rm` when `$x` is `-c`: each of the shell's arguments is walked as code it may run, and one
only known at run time is a finding.
