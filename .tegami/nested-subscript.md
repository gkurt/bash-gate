---
packages:
  'bash-gate': patch
---

### An array literal's subscript closes where Bash closes it

Brackets in a subscript nest: Bash reads `b=([a[1]=1); # $(cmd) ]=2)` as one element, whose subscript runs `cmd`, where
the parser ended it at the first `]` and read the rest as a comment. A subscript that doesn't close where the parser
ended it is a parse error, and one that does is read up to its matching `]`.
