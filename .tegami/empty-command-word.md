---
packages:
  'bash-gate': patch
---

### A command word that may expand to nothing also runs the next word

`$x rm -rf /` is denied: with `$x` empty, Bash runs `rm`. It was only a command name known at run time, which asks.
