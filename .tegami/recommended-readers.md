---
packages:
  'bash-gate': minor
---

### `recommended` allows `sed` and `awk` scripts that only edit what they read, and more programs that only look

`sed -n '1,40p' file` and `awk '{print $1}' file` run. A sed script is read command by command: `e`, `w`, `r` and the `e` and `w` flags of `s` are found wherever sed reads them, and a script that isn't followed (text for `a`, `i` and `c`, a delimiter in a bracket expression, an option the spec doesn't know) is `exec:arbitrary`. An awk program with `system`, a pipe, `getline`, `@` or a `>` after a `print` is `exec:arbitrary` or a write. Either writing a file asks, in place included.

Also allowed: `uniq`, `expand`, `unexpand`, `date`, `nproc`, `uptime`, `free`, `df`, `ps`, `pgrep`, `printenv`, `cksum`, `b2sum`, `sha224sum` and `sha384sum`.

### `sed -f` and `awk -f` are `exec:file`

A script file runs commands of its own. `awk -f` was `exec:project`, which `recommended` doesn't ask about, and `sed -f` had no effect at all.

### `date` with a time to set is `privilege`

`date 010100002030` and `date --se=now` set the clock as `date -s` does.
