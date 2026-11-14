---
packages:
  'bash-gate': patch
---

### `yq -i` and `file -C` write files

`yq -i '.a = 1' ~/.bashrc` was allowed as a read. `yq -i` writes the files it's given, `yq -s` and `file -C` write files named as they run.
