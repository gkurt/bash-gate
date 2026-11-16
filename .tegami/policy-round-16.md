---
packages:
  'bash-gate': patch
---

### `/dev/tcp`, `checkout -p`, cargo's `--logfile`, workspace selectors, and project code after git rewrote the tree

- A redirection to Bash's `/dev/tcp/host/port` or `/dev/udp/…` is `network`, and so is one only known at run time.
- `git checkout -p` discards the hunks it's told to, and asks as `restore -p` does.
- `cargo test -- --logfile <file>` (and `bench`) writes that file.
- `npm -w`, `pnpm --filter` and `-w`, `bun --filter`, and cargo's `-p`, `--workspace` and `--exclude` run another
  package's code: `exec:file`, unless the value is a path inside the project.
- Without a filesystem, project code run after git rewrote the work tree is `exec:file`, as with one.
