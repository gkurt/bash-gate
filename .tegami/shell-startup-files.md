---
packages:
  'bash-gate': patch
---

### A shell that runs its startup files is a finding

`bash -i` reads `~/.bashrc` unless given `--norc`, and a login shell (`-l`, `--login`) reads `/etc/profile` and
`~/.profile` unless given `--noprofile`: code the analysis doesn't see, so an `exec-config` finding.
