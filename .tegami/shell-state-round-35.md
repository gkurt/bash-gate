---
packages:
  'bash-gate': patch
---

### Loops, line continuations, FUNCNEST and an inherited CDPATH are followed as Bash runs them

- A `while` or `until` loop ends right after the clause that stops it, with what that clause changed.
- A backslash before a newline continues the line, so an alias defined or removed earlier on it isn't in effect yet;
  one ending a comment continues nothing.
- A loop in a function isn't taken as settled from another call with other values outside, which the return puts back.
- Assigning `FUNCNEST`, past which function calls fail and the rest of the line is dropped, is a finding.
- A `CDPATH` from the environment makes where `cd name` goes only known at run time, as one assigned in the script does.
