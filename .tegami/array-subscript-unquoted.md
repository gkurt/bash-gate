---
packages:
  'bash-gate': patch
---

### An array literal's subscript is expanded again once its quotes are gone

In `a=([subscript]=value)`, Bash removes the subscript's quotes and expands what's left: `a=(['$'('rm -rf /)']=1)` runs
`rm`, and was allowed.
