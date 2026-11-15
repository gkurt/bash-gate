---
packages:
  'bash-gate': patch
---

### Hooks are followed in the directory `core.hooksPath` names

With a filesystem, a repository whose config sets `core.hooksPath` (husky does) had every git command ask. The hooks there are now read like those in `.git/hooks`, and the finding stays only where the directory isn't certain: a relative path with `--git-dir` or `--work-tree`, `~` without a known `HOME`, or a path set in a conditional include.

### Every git command is checked for the hooks it runs

`git status` runs `post-index-change`, any ref update `reference-transaction`, `git restore` `post-checkout` and `git pull` the hooks of a merge and a rebase: none were read. A command the table doesn't have, or an alias, is checked for every hook.

### A hook defined in git config is code

Recent gits (2.55 does) run `hook.<name>.command` on the event `hook.<name>.event` names, so `git -c hook.x.command=… -c hook.x.event=reference-transaction branch b` ran a command `recommended` allowed. `config.worktree` is read with the repository's config too.
