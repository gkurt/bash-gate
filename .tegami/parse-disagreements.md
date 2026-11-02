---
packages:
  'bash-gate': patch
---

### More places the parser and Bash disagree are parse errors

A here-document that's never closed, which in a substitution Bash ends elsewhere than the parser does; an array
assignment with text after it (`v=(…)x`), which Bash expands as a string where the parser sees no substitutions; a
process substitution after digits (`2>(…)`), which Bash runs and the parser read as text; a `${…}` the parser
couldn't read, such as `${a[$(f)}]}`, where Bash runs `f`; a `$` before a line continuation, which Bash joins to the
name after it; and an expansion that's never closed in a here-document or prompt string, which the parser closes
without an error. `cat a 2>(rm -rf /)` was allowed.
