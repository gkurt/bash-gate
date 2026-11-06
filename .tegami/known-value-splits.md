---
packages:
  'bash-gate': patch
---

### A dynamic word may split where a known value in it does

`"$(cmd)"$x` with `x='a b'` is two words in Bash, but was read as one, so `covers` missed the run that got two.
