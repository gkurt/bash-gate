---
packages:
  'bash-gate': patch
---

### Files printed in error messages, yq's `eval`, and npm's own `env` and `restart` scripts

- **Lists of names:** `du --files0-from=FILE` and `find -files0-from FILE` print a file that holds no NUL-separated names whole in their error, so one that names a secret is `secrets:read`, as `wc --files0-from` already was. find's starting points from such a file are only known at run time (`-delete` on them asks).
- **`git grep -f`:** its pattern file is a read; a line that doesn't compile is printed in the error.
- **`MAGIC`:** setting it is a sensitive variable. `file` reads it as its magic file and prints each line it can't parse.
- **yq `eval`:** an expression with `eval(…)` runs a string built at run time, which may read the environment or files: `secrets:read`.
- **npm's built-in scripts:** `npm run env` without an `env` script runs `env`, which prints the environment, and `npm run restart` without a `restart` script runs `npm stop --if-present && npm start`. Both are followed.
