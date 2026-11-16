---
packages:
  'bash-gate': patch
---

### A file named only at run time may be a secret's

A path only known at run time now counts as `secrets:read` when the program reads it. It may come from a substitution, input, a variable or the script's arguments: `cat $(echo .env)`, `read f; cat "$f"`, `find . -name .env | xargs cat`, `find ~/.ssh -exec cat {} +`, `cat "$1"`. Hiding a secret's name no longer turns an ask into an allow.

It doesn't count when the known end of the name rules a secret out (`cat "$name.ts"`), or for a loop over a static glob that matches no secret (`for f in src/*.ts; do cat "$f"; done`). `xargs grep TODO < list` now asks.
