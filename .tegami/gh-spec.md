---
packages:
  'bash-gate': minor
---

### `gh` has a spec

Its argv is read as cobra reads it, so `gh -R o/r pr merge` is `pr merge` with `--repo`, and each command gets its options and effects (API calls are `network`; `pr checkout` and `repo sync` run git hooks). Code gh runs is walked: shell aliases (`gh alias set x --shell …`), the editor, pager and browser in `gh config set`, the git flags `gh repo clone` passes to `git clone`, and the command `gh codespace ssh` runs. An unknown first word is an alias or extension, `exec:arbitrary`. `GH_PAGER`, `GH_EDITOR`, `GH_BROWSER`, `BROWSER`, `GH_CONFIG_DIR` and `GH_PATH` are sensitive variables.
