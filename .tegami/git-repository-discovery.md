---
packages:
  'bash-gate': patch
---

### Git's config and hooks are read from the repository git takes

With a filesystem, only `<root>/.git/config` was read. Git also takes the directory `--git-dir` or `--bare` names, and any directory that has a `HEAD`, `objects` and `refs` itself, so `git --git-dir=r status` and `cd r; git fetch o` ran the `core.fsmonitor` and `core.sshCommand` of a directory made by hand, unseen. A `.git` git doesn't take (one with only a `config`) no longer hides the repository above it. `--work-tree` is where git's rewrites of the work tree count.

### `recommended` asks about any write inside a `.git`, and to a file named `HEAD`

Without a filesystem that is what stops a repository made by hand. Writes to `.git/info` or a submodule's `.git/modules/*/config` were allowed.
