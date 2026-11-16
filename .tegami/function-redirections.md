---
packages:
  'bash-gate': patch
---

### Redirections on a function call

The redirections on a call to a shell function (`f > ../x`, `f >> ~/.bashrc`, `f < /dev/tcp/…`) are judged, as they
would be on `:`: the function's body was, command by command, but what the call itself opens wasn't.
