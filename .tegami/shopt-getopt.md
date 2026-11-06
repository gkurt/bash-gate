---
packages:
  'bash-gate': patch
---

### `shopt` reads its options as Bash does

A lone `-` ends them and is a name, so `shopt - -s expand_aliases` turns nothing on, and a word with a letter Bash
rejects (`-s-`) changes nothing. Both were read as `shopt -s expand_aliases`, which made the analysis expand aliases
Bash didn't.
