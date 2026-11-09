---
packages:
  'bash-gate': patch
---

### An `env -S` string uutils reads differently leaves the command unknown

uutils' env splits only `-S`, `-vS`, `-vvS` and `--split-string` as spelled, before the first word that isn't an option,
and never again in what it split. Any other `-S`, such as `--split cat` or `-iScat`, it ignores, so the command
depends on which env runs it.
