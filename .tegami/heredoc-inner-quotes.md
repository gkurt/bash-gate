---
packages:
  'bash-gate': patch
---

### Inner quotes in a here-document's default

As in a double-quoted string, Bash removes the inner quotes in a here-document's `${u:-"$"("cmd)"}` before expanding
it, so `cmd` runs; so does arithmetic, which is expanded the same way.
