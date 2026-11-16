---
packages:
  'bash-gate': patch
---

### Files named by an option's value, and more ways awk, gh and bun read secrets or write outside

`secrets:read` now covers secret files named this way:

- **Option values:** the value of an option the spec doesn't know (`git blame --contents=.env`, `git add --pathspec-from-file=.env`, `wc --files0-from=.env`), and a `git -c` config value (`-c blame.ignoreRevsFile=.env`). The program reads these files, and prints them or their lines in an error.
- **Spec fixes:**
  - `git blame` and `annotate` know `--contents` and `--ignore-revs-file`.
  - `git log` knows `-L`.
  - GNU diff's `-d` and `-f` and util-linux column's `-d` and `-L` take no value. They had hidden the file that followed them.
  - `file -f` and `-m`, and `diff --from-file` and `--to-file`, are reads.
- **Index stages:** `git show :0:.env` (a stage of the index).
- **awk:** `SYMTAB`, `PROCINFO` and `ARGV`/`ARGC` in an awk program.
- **gh:** a `--jq` filter that reads the environment.

Also:

- bun's `--cpu-prof-name`, `--cpu-prof-dir`, `--heap-prof-name` and `--heap-prof-dir` are writes to the path they name.
- `core.protectNTFS` and `core.protectHFS` are git config keys that can lead to code running.
