---
packages:
  'bash-gate': patch
---

### What a wrapper starts is found on `PATH`, not in the shell's `hash -p` table

`hash -p /bin/true rm; env rm -rf /` was read as `env true -rf /`; `env`, `sudo`, `xargs` and the other wrappers now
run `rm`, as they do in Bash. The shell's own lookups, `command` and `exec` still use the table.
