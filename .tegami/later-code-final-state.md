---
packages:
  'bash-gate': patch
---

### Traps and prompt strings see what's defined after them

Trap actions, prompt strings and `PROMPT_COMMAND` are also walked with the state at the end of the script, so `trap 'f' EXIT; f() { rm -rf /; }` is denied.
