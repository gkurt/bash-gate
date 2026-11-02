---
packages:
  'bash-gate': patch
---

### A name `hash -p` gave a path may run from `PATH`

Bash looks the name up on `PATH` when the path isn't there, so `hash -p ./missing rm; rm -rf /` runs `rm`.
