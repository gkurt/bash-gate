---
packages:
  'bash-gate': patch
---

### Aborts, `stash export`, `git config edit`, `cp -T`, `cargo rustc --` and more options that load code

- `recommended` asks about `git merge`, `rebase`, `cherry-pick` and `revert` with `--abort` or `--skip`, which put the
  work tree back over a resolution and what's staged, and about `git stash export --to-ref`, which moves a ref.
- `git config edit` runs an editor on the file it names, as `-e` does.
- `cp -T` copies a directory onto its target, under names only known at run time.
- The words after `cargo rustc --` or `cargo rustdoc --` (a linker, an output file) run as `exec:arbitrary`.
- `bun --tsconfig-override` and `--jsx-import-source`, and `jest --env`, load code. `MANOPT` is sensitive.
