---
packages:
  'bash-gate': patch
---

### Braces in `alias` and `declare` arguments are expanded

`alias l="ls -la"{x,y}` defines `l` twice, the last time as `ls -lay`, and `declare v=a{b,c}` sets `v` to `ac`. The
analysis kept the braces in the value.
