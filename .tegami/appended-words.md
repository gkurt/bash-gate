---
packages:
  'bash-gate': patch
---

### Words `xargs` appends are read with the command line

`echo 'rm -rf /' | xargs env` was allowed: the words `xargs` adds were counted after the command was read, so a wrapper given no command ran them unseen, and `xargs cp payload` or `xargs tee` wrote files no rule saw. They're now read as the rest are: as the command a wrapper runs, an option, or a file written.

### A word that may be several before a wrapper's command leaves the command unknown

`timeout $(cat list)` and `nice -n $(cat list)` were allowed, though the words may hold the command itself. So is a word that may be an option before `timeout`'s duration.
