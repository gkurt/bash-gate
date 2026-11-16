---
packages:
  'bash-gate': patch
---

### Writes to the user's configuration are caught however they're spelled

- `~` globs also match a write's real path and where HOME really is (`Analysis.realhome`): a symlink to `~/.bashrc`, or
  HOME given by a path that leads to the start.
- A rule that may match is tried on the path in lower case too: `~/.BASHRC`, `~/.SSH/…` on a filesystem that ignores case.
- A `cwd` that isn't a POSIX absolute path (`C:/w/p`, `p`) places nothing, as no `cwd` doesn't.
- `cp`/`mv` with `-b` write the backup too, under `-S`'s suffix, or a name only known at run time without one.
- `recommended` asks about `~/.ssh` and `~/.config/git` themselves (a whole directory copied in), `~/.config`,
  `~/.bash_aliases`, `~/.bash_logout`, `~/.zlogin`, `~/.zlogout`, `~/.local/bin`, `~/.npmrc`, `~/.bunfig.toml` and
  cargo's user config.
