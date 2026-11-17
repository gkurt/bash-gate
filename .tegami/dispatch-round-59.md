---
packages:
  'bash-gate': patch
---

### `jobs -x`, `source` in POSIX mode, `exec -a` with a path, and write options' effect

- **`jobs -x`:** `jobs -x cmd args` runs the command in this shell (functions and builtins too), and it's now followed as one. A jobspec among its words (`%1`) is only known at run time.
- **`source` in POSIX mode:** Bash finds `source`, like `.`, before a function of that name in POSIX mode. `source() { :; }; set -o posix; source ./x.sh` runs the file, and now reads as it.
- **`exec -a` with a path:** a name with a `/` in it that isn't the command as written counts as a rename. stdbuf preloads the `libstdbuf.so` beside its `argv[0]`, so `exec -a ./evil/stdbuf stdbuf …` loads a library from `./evil`.
- **Write options:** an option a spec marks as naming a file it writes (`time -o`, `strace -o`) adds `fs:write`, as positional writes do.
