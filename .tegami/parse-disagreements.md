---
packages:
  'bash-gate': patch
---

### Three more places the parser and Bash disagree are parse errors

A here-document that's never closed, which in a substitution Bash ends elsewhere than the parser does; an array
assignment with text after it (`v=(…)x`), which Bash expands as a string where the parser sees no substitutions; and a
process substitution after digits (`2>(…)`), which Bash runs and the parser read as text. `cat a 2>(rm -rf /)` was
allowed.
