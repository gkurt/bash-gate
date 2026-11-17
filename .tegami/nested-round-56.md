---
packages:
  'bash-gate': patch
---

### Nested repositories under `--git-dir` and `--work-tree`, submodules' kept git directories, and the index read as git reads it

- **`--git-dir` and `--work-tree`:** `git --git-dir=.git status` now follows the submodules and gitlinks of the work tree as `git status` does, and a `git --git-dir=… add` makes a later git command list the work tree. The gitlinks the index records are looked for in the work tree `--work-tree` names, not where git started. A `--work-tree` only known at run time is a finding.
- **Submodules' git directories:** every git directory under `.git/modules` is followed, whether a work tree holds it or not. `git fetch` recurses into a submodule that isn't checked out, and `git checkout --recurse-submodules` (or `submodule.recurse`) checks one out again, and both run its `core.fsmonitor` and hooks. Without `readdir`, a `.git/modules` that's there is `exec:nested`.
- **The index:** an entry's name is read with the length its flags give, as git reads it. One whose NUL isn't there is no longer read past, so a crafted index can't hide a gitlink.
- **Case:** a nested `.GIT` found by `readdir` is followed, as a filesystem that folds case finds it as `.git`.
