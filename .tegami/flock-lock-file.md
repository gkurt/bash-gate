---
packages:
  'bash-gate': patch
---

### `flock`'s lock file is a write

`flock FILE cmd` and `flock FILE -c CODE` create `FILE` when it's missing, so the lock file counts as written.
