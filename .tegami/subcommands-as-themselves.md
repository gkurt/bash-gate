---
packages:
  'bash-gate': patch
---

### git and npm subcommands are named as themselves

`git revert` was `cherry-pick` and `npm unpublish` was `publish`, so rules naming them never matched; only real aliases (`npm i`, `git remote rm`) share a name now. `npm tst`, `npm rum` and `npm restart`'s stop and start scripts are followed, and `git ls-remote` reaches the network.
