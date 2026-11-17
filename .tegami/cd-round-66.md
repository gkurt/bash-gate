---
packages:
  'bash-gate': patch
---

### A `cd` that fails after it moved

- **`cd -`, CDPATH and `cdable_vars`:** these print the directory `cd` went to, and when that print fails (`cd - >&-`), `cd` has already moved but returns 1. A branch taken on its failure (`|| …`, `if ! cd …`) is no longer placed in the directory it left, and neither is one after `cd` with an argument only known at run time.
