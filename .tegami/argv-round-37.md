---
packages:
  'bash-gate': patch
---

### More options and commands read as the programs read them

- `git stash list` takes log options: its `--output` is a write.
- `tsc @file` reads more options from the file, which may write anywhere: it asks.
- nopt (npm, pnpm) splits `-C=dir` at the `=`, and reads a word of shorthands letter by letter (`npm -Cd ls` is
  `npm info ls`): such a cluster is an unknown option.
- Where a valued option meets a word starting with `-` (pnpm, vite, vitest, tsdown, prettier, jest), either reading is
  taken: some options take it, and the words after may be options.
- `bun up` is `bun update`; pnpm's `purge`, `uni`, `dislink`, `clean-install` (`ic`, `install-clean`), `peers`,
  `owners`, `undeprecate`, `prefix`, `set-script` (`ss`), `change`, `lane` and `pack-app` are its own commands, not
  scripts.
