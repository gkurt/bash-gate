---
packages:
  'bash-gate': patch
---

### Specs checked against the programs' documentation

Each of these was allowed while the program did more:

- `watch -s` (`--shotsdir`) takes a directory, so the command is the words after it.
- yq writes a file per document with `--split-exp-file`, and runs programs with `--security-enable-system-operator`.
- jest writes `--cacheDirectory` and `--coverageDirectory`, and `--clearCache` deletes the cache directory.
- git runs `gpg.ssh.defaultKeyCommand`, `trailer.<key>.command` and `.cmd`, `core.alternateRefsCommand` and
  `gc.recentObjectsHook`.
- `git config --global` writes `~/.gitconfig`, `--system` `/etc/gitconfig` and `--worktree` `.git/config.worktree`.
- A merge strategy git doesn't have (`git merge -s evil`) is `git-merge-evil` from PATH, for merge, pull, rebase,
  cherry-pick and revert.
- `git help -w` opens a browser.
- Setting `RIPGREP_CONFIG_PATH` is a finding: the file may name a program rg runs.
- `sort -T` writes its temporary files in that directory.
- tree reads a cluster's letters one at a time, each taking the next word after it: `tree -Lo 2 x` writes `x`.
