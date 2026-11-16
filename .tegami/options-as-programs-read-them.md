---
packages:
  'bash-gate': patch
---

### Options as the programs read them: git's, pflag's `-o=value`, xargs, watch, touch, cp, rg and `POSIXLY_CORRECT`

Each of these was allowed while the program did something else:

- `git --attr-source`, `--shallow-file` and `--super-prefix` take the next word, which isn't the subcommand.
- `git config set key value` and `git config --comment hi key value` set `key`: the subcommand and the value options
  of `git config` are read, and unsetting or renaming writes the config file as setting does. `git config -e` runs
  an editor.
- `git reflog expire`, `delete` and `drop` delete entries, a stash among them.
- `git blame`, `annotate`, `shortlog`, `rev-list`, `whatchanged`, `reflog` and `stash show` write `--output`.
- `git branch -M` and `-C` force, as `-D` does.
- `git commit -Sn` is `-S` with the key `n`, and `--verify` after `--no-verify` runs the hooks again.
- A Go program's `-o=value` (cobra's pflag) has the value `value`.
- `xargs --max-lines` takes a value only after `=`, and `watch -d` takes one attached.
- `touch -m` is a flag, so the word after it is a file to write.
- `cp` and `mv` know `--sparse`, `--no-preserve` and their other options. With one they don't know, any operand may
  be the target.
- `rg --hostname-bin` runs a program.
- `POSIXLY_CORRECT` makes GNU programs stop reading options at the first operand: setting it, or a program run with
  it in its environment, is a finding. Bash starts in POSIX mode with it in the environment.
