---
packages:
  'bash-gate': patch
---

### A function's local variables are put back when it returns

`local`, and `declare` or `typeset` without `-g`, in a function kept their value after it: `x=/; f() { local x=./build; }; f; rm -rf $x`
was read as `rm -rf ./build`. A new local without a value is unset, and what the function starts sees the exported one
from outside. Options end at the first name, so `declare x -g y=1` is local.
