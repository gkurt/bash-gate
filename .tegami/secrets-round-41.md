---
packages:
  'bash-gate': patch
---

### More ways a secret is copied, printed or reached are `secrets:read`

`secrets:read` catches more ways a secret reaches output: a secret variable copied by an assignment, a loop's words, `${!x}` or a nameref; evaluated as arithmetic or tested as a number, whose error prints it; matched into `BASH_REMATCH`; or tested under `set -x`. It also catches `ps e` anywhere in its arguments and `ps -E`, awk's `ENVIRON`, jq's `env` and `$ENV`, yq's `env()` and `strenv()`, globs that may match a credentials file (`.e?v`, `~/.aws/*`), a secret file renamed with `mv` or `ln`, `git show HEAD:.env`, a redirection through a link, thread environments under `/proc`, and more credentials files and variable names (`PGPASSWORD`, `MYSQL_PWD`, `GITHUB_PAT`). `PASSWORD_STORE_DIR`, `NEXT_PUBLIC_…_KEY`, `${TOKEN:+set}` and source files like `.env.ts` no longer count.
