---
packages:
  'bash-gate': patch
---

### `$'\U…'` past Unicode, and variables Bash sets as it starts, are read as Bash reads them

- A `\U` escape from 0x80000000 is dropped, as Bash drops it (`$'\UFFFFFFFF'rm` is `rm`); one from 0x110000 makes the
  word only known at run time, as Bash writes bytes of its own for it. The parser kept the escape's text.
- `IFS`, `SHLVL`, `BASH`, `BASH_VERSION`, `OPTERR`, `PS2`, `PS4` and the other variables Bash sets as it starts are
  only known at run time, whatever `environment.env` gives: Bash ignores an imported `IFS` and counts `SHLVL` up.
