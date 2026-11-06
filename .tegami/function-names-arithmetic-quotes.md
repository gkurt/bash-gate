---
packages:
  'bash-gate': patch
---

### A function name with quotes defines nothing, and double quotes in arithmetic

Bash refuses to define `'r'm() { :; }` or `\rm() { :; }`: `rm` still runs the program, where it was read as the
function. And arithmetic is also walked with its double quotes gone, as a subscript Bash expands again has them gone.
