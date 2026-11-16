---
packages:
  'bash-gate': patch
---

### Git's editor, more build tools' variables, and npm config in any case are caught

- Git forms that open the editor ask, as `git config -e` does: its default `vi` reads commands from the script's input
  (`printf ':!cmd' | git commit`). That's `commit` without a message, `tag -a`/`-s` without one, `rebase -i` and
  `--edit-todo`, `--edit` on commit, merge, tag, cherry-pick and revert, `--continue`, and `branch --edit-description`.
- npm reads `npm_config_*` from the environment in any case (`Npm_Config_Script_Shell`): all of them are sensitive.
- `PKG_CONFIG*`, `CMAKE*`, `PROTOC*`, `PYO3_*`, `LIBCLANG_PATH`, `CLANG_PATH`, `LLVM_CONFIG_PATH` and `BINDGEN_*`, which
  pick the programs cargo's build scripts run, are sensitive.
- jest's `--coverageReporters` are modules it loads; git's `branch.*.mergeOptions` and `pull.twohead`/`pull.octopus`
  may name a merge strategy, which runs `git-merge-<name>`.
