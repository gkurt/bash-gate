---
packages:
  'bash-gate': patch
---

### grep, and sed, awk or jq that may pass a line through, print the secrets they read

`secrets:print` now covers four more programs, read directly or through a pipe:

- **grep:** prints the lines it matches whole (`grep KEY .env`, `env | grep TOKEN`), unless it only tests, counts or names files (`-q`, `-c`, `-l`, `-L`).
- **sed, awk and jq:** print a secret when their script may pass a line or value through unchanged:
  - sed without `-n`, or with a command that prints (`sed 's/^export //' .env`, `sed -n '/KEY/p' .env`);
  - an awk program that uses a field, prints with no arguments, or has a pattern with no action (`awk -F= '{print $2}'`, `awk '/KEY/'`);
  - a jq filter with a path or a variable in it (`jq .auths`).

These stay read but not printed:

- programs that can't pass a line through: `awk '{print length}'`, `jq length` and `sed -i`;
- `cut`, `wc`, `tr` and `sort`'s keys.
