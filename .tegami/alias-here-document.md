---
packages:
  'bash-gate': patch
---

### An alias that opens a here-document is a parse error

Its body is the lines after the command, which the parser reads as commands, so a `<<` among them hid the rest:
`alias c='cat <<EOF'`, then `c`, `<<D`, `EOF` and `rm -rf /` on their own lines, was allowed.
