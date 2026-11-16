---
packages:
  'bash-gate': minor
---

### `recommended` in a project under HOME, an `outputs` rule field, and more destructive git forms

- A project under `HOME`, as most are, is judged as one anywhere else: `recommended` no longer names `~` among the
  places outside the working directory, since `..` from an absolute `cwd` covers it, and a path that can't be placed
  may be outside. `~/.bashrc` still asks.
- Rules take `outputs`: globs for the files an invocation's own arguments name (`sort -o`, `sed`'s `w`), without its
  redirections. `Invocation.outputs` holds them. `recommended` uses it for `sed`, `awk`, `uniq`, `xxd` and `tree`, so
  `sed -n 1,5p a > out.txt` runs.
- Deny and ask rules match `head` in any case as `HEAD`, and `GIT~1` as `.git`.
- `recommended` asks about `git checkout -B`, `switch -C`, `checkout -f`, `switch --discard-changes`, `checkout --ours`
  or `--theirs`, paths checked out from a commit, `restore` of the work tree, and `fetch --prune` into local branches or
  tags; it denies `git push --prune`.
- `GIT_TRACE2*` and other git variables with a digit are sensitive. `cp -s`, and copies that keep symlinks (`-P`, `-d`,
  `-a`, `-r` without `-L`), count their sources as written. `cargo fmt -- file` rewrites that file.
