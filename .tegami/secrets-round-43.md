---
packages:
  'bash-gate': patch
---

### More ways Bash shows a secret are `secrets:read`

`secrets:read` catches more ways Bash shows a secret:

- `declare -px NAME` and other `-p` clusters, and `local -p`;
- a prompt string that expands one (`PS4` under `set -x`, `${x@P}`);
- names evaluated as arithmetic: subscripts, offsets, `[[ X -eq 0 ]]`, integer variables, and a variable whose value names a secret;
- `[ … ]` forms whose error prints their words, and `test`, which leaves its last word in `$_`;
- globs under `dotglob` or `GLOBIGNORE`;
- `git config --file`;
- yq's `load…()` and jq's `import`.

`git ls-files .env`-style commands that only name a file, `cp .env.example .env`, token counts like `MAX_TOKENS`, and jq's `{env: …}` keys no longer count.
