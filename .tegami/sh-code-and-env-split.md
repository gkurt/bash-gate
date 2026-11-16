---
packages:
  'bash-gate': patch
---

### Code `sh` runs, and `env -S`'s other separators

- Code other programs hand to `sh` (`watch '…'`, `git rebase -x`, `tsdown --on-success`) was read as Bash with
  aliases off. Where `sh` is dash, `&>` runs in the background, `((` opens two subshells and `$'…'` is no string, so
  `watch 'ls &>/dev/null rm -rf y'` was allowed. Such code, and hooks and package scripts that `sh` runs, is read as
  Bash in POSIX mode with aliases on, and Bash's own syntax in it is a finding.
- `env -S` also splits at `\v`, `\f` and `\r`, and expands no braces: a string with one is only known at run time.
