---
packages:
  'bash-gate': patch
---

### Dry runs only where the program honors them, and only when the real command they name is the same

- npm's `--dry-run` lowers only the commands that honor it: `install`, `ci`, `update`, `uninstall`, `dedupe`, `prune`, `link`, `pack`, `publish` and `unpublish`. npm ignores it elsewhere, and `npm --dry-run run deploy`, `dist-tag add`, `owner add`, `version` and `pkg set` were allowed as rehearsals although they run for real.
- A command whose words without the dry-run option would read as another command is no dry run. In `git clean -n -fen -x`, one `n` is `-e`'s value, so `invocation.dryRun` named a different command.
- A plugin or a subcommand the spec doesn't know gets no `dryRun`.
- `git fetch --dry-run` keeps `fs:write`, because it still stores the objects it downloads.
- helm's `--dependency-update` writes into the chart, dry run or not.
