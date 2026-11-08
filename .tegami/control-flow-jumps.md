---
packages:
  'bash-gate': patch
---

### `break`, `continue` and `return` skip the rest of a loop or function

What holds at each counts after the loop or call: in `f() { x=rm; return; x=ls; }; f; $x -rf /`, `$x` is `rm`.

### An arithmetic `for` loop's test and update see what the body changed

They run again after each pass, so a subscript the body assigns is expanded.
