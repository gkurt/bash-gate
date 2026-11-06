---
packages:
  'bash-gate': patch
---

### Inner quotes in a default, in pairs and in `$"…"`

Bash removes the inner quotes of a default in pairs, `$"…"` ones included, so `"${u:-$"""$"("rm -rf /)"}"` runs `rm`;
and it does the same in a `$"…"` string as in a double-quoted one.
