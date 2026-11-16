---
packages:
  'bash-gate': patch
---

### More git checkout forms, `fetch --stdin`, `cp --parents` and `sed -i` backups

- `recommended` asks about `git checkout -- <path>`, `-m` and `--conflict` (which check out paths as merged),
  `-2` and `-3` (git's `--ours` and `--theirs`), and `--pathspec-from-file`, all of which overwrite local changes.
  `Parsed.separated` says whether `--` ended the options.
- `git fetch --stdin` reads refspecs that may force or prune local branches, so it counts as `--force`.
- `cp --parents` writes each source under the target by its whole path, `..` and all.
- `sed -i`'s backup is written too: the suffix after the file's name, or with a `*`, a path of its own.
