---
packages:
  'bash-gate': patch
---

### The shell a wrapper starts, relative paths under enforcement, `SHELL`, and `unshare` or `chroot` with no command

- `bash-gate/trace` covers the shell a wrapper runs code through (`flock -c`, `watch`, `dash -c`) only when it's the
  system's: `SHELL=./bash flock -c …` and a `PATH` set in that code no longer run another file named `bash`.
- A relative path is covered by the file it reaches from where the process really is, so `cd link && ../tool` through
  a symlink isn't taken for the `../tool` predicted.
- `SHELL` is sensitive: `flock -c`, `script -c`, `unshare` and `chroot` run it.
- `unshare` and `chroot` with no command run a shell on their input or a terminal: `exec:arbitrary`.
