---
packages:
  'bash-gate': patch
---

### `local` outside a function changes nothing

As in Bash, where it's an error. `x=-rf; local x=; rm $x /` is denied.
