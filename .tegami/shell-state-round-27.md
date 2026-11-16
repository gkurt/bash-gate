---
packages:
  'bash-gate': patch
---

### Shell state follows when Bash expands a tilde, what a function's return puts back, and an alias on a function's name

- An unquoted `~`, `~+` or `~-` in an assignment, `export`/`declare`/`local` and a `for` list is expanded as it's
  assigned, so `d=~+; cd elsewhere; echo x > $d/f` writes where the assignment ran.
- A function's return puts a local's variable back to what it was when `local` ran: `f() { d=/tmp; local d=.; }` leaves
  `d` at `/tmp`.
- `declare -g` with a value under a temporary assignment of the same name keeps the value after the command.
- An assignment-only command (`x=/tmp >$x/f`) redirects with the values it just assigned.
- With aliases on, the name of a `name()` definition is alias-expanded, as Bash does: `alias rm=zz; rm() { …; }` defines
  `zz`, and `\rm` is still the program.
