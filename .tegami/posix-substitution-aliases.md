---
packages:
  'bash-gate': patch
---

### Substitutions' aliases in POSIX mode, inner quotes in a quoted default, and names running out of braces

In POSIX mode Bash runs a command substitution as it parsed it with the line around it, so with that line's aliases
and none it defines itself: `{ alias rm=true; x=$(rm -rf /); }` on separate lines runs `rm`. In
`"${u:-"$"("rm -rf /)"}"` Bash removes the inner quotes before expanding, and runs `rm`. And braces expand before any
expansion in the word, so `{$,}s` is `$s s`.
