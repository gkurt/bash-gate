---
packages:
  'bash-gate': patch
---

### Enforcement checks where a program is and the name it's started under

- `bash-gate/trace` held an exec to the program's file name only. Now the file must be where the invocation says (the
  path it was given, or a directory of the run's `PATH` for a name), so a `./ls` in the project isn't taken for `ls`,
  and the name it's started under (`argv[0]`) must be predicted too.
- `exec -a name` and `exec -l` start a program under another name, which some act on (`pgrep` as `pkill`, `git` as
  `git-branch`): the analysis gives it a `loads-code` finding.
- `find -exec … {} +` passes as many paths as fit, so its last `{}` may be several words: such runs are no longer
  refused.
