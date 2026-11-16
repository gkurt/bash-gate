---
packages:
  'bash-gate': patch
---

### History files, dash's missing builtins and `find --` are followed

- Assigning `HISTFILE` or `HISTFILESIZE` is a finding: Bash truncates the history file as `HISTFILESIZE` is set, and
  `set -o history` appends the script's own lines to it on exit (`HISTFILE=~/.bashrc`).
- Code handed to `sh` (`watch`, `git rebase -x`, hooks, package scripts) that calls a builtin dash doesn't have
  (`declare`, `shopt`, `source`, `let`, …) is a finding: dash reports it not found and runs on without it.
- `find --` ends find's leading options: the starting points follow it (`find -- / -delete`).
