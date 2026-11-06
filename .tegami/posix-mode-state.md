---
packages:
  'bash-gate': patch
---

### POSIX mode is followed as Bash follows it

`set` applies its options one at a time, as Bash does: `set -o[ posix` turns POSIX mode on before it fails at `[`.
Entering POSIX mode turns `expand_aliases` on and leaving turns it off, but `set -o posix` when it's already on
changes nothing; assigning `POSIXLY_CORRECT` always enters it, and unsetting it always leaves. In POSIX mode a
substitution Bash only parses as it runs, in a here-document or in text it expands again, gets no aliases.
