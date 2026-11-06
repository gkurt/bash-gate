---
packages:
  'bash-gate': patch
---

### A process substitution's aliases in POSIX mode, at parse time and at run time

In POSIX mode Bash expands a process substitution's aliases as its line is parsed, then again as it runs, so either
may be what runs: `alias ls="rm -rf /"; { alias ls=cat; cat <(ls); }` on separate lines runs `rm`.
