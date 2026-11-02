---
packages:
  'bash-gate': patch
---

### Two more places the parser and Bash disagree are parse errors

A here-document that's never closed, which in a substitution Bash ends elsewhere than the parser does, and an array
assignment with text after it (`v=(…)x`), which Bash expands as a string where the parser sees no substitutions.
