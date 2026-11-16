---
packages:
  'bash-gate': patch
---

### Hooks, shebangs, symlinked directories and case are read as git and the kernel read them

- A git command's hooks are read again once they've all been walked: a hook that writes another (`pre-commit` writing
  `reference-transaction`, which git runs after it) or the dispatcher husky's stubs source is a finding.
- A hook's first line counts only when it names a system shell, with no options but `set`'s (`#!/bin/sh -e`), or the
  shell `env` finds with nothing else: `env -S …`, `bash -i` or a shell elsewhere is a finding.
- `git -C`, `--git-dir`, `--work-tree` and `env -C` resolve `link/..` as the kernel does, from where the symlink leads.
- A write in another case (`.HUSKY/pre-commit`, `PACKAGE.JSON`) counts as a write to the file git or npm reads later.
- A `~` path with HOME unknown is never asked of the `FileSystem`: it's a finding.
