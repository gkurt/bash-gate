---
packages:
  'bash-gate': patch
---

### Where writes land, and what hooks and scripts run

Each of these was allowed while the command wrote outside the project, into `.git`, or ran something else:

- `echo x > link/../passwd`, with `link` a symlink out of the project: a `..` after a symlink leads up from where it
  points, as the kernel resolves it.
- `echo hi > .GIT/hooks/pre-commit`: a rule's `.git` matches any case, as on a filesystem that ignores it.
- `cp -r /tmp/x/.git .` and `cp -t . /tmp/x/.git` write `./.git`: into a directory, each source lands under its own
  name, and a directory's contents (`x/.`) under names only known at run time. `cp -l` makes the source itself
  writable through the copy, so it counts as written.
- A git hook is read as the shell its first line names, `sh` when there's none, and a hook in another language is a
  finding. Hooks and package scripts run by `sh` expand aliases.
- A repository further up than 16 directories is a finding, not none at all.
- `git mv`, `git restore` and `git checkout` write the paths they're given, which may be outside the working directory.
