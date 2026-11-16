---
packages:
  'bash-gate': patch
---

### What children inherit, aliases Bash doesn't expand or names with braces, `local -`, and `cd`

- `export -n`, `declare +x` and `unset` take a variable's export away, and `env -i`, `-u` and `NAME=` change what the
  command they run, and a shell under it, gets.
- No alias is expanded after an assignment followed by a redirection (`x=1 >f rm`), and an alias is looked up by the
  word as written, braces and all (`{ls,.}`).
- Returning from a function with `local -` puts POSIX mode back as `set` does, turning aliases with it; an
  `expand_aliases` the function changed may be either after.
- A logical `cd` whose `..` path isn't there goes where the kernel reads it, up from where a symlink leads; and with a
  nameref on `PWD` or `OLDPWD`, `cd` may fail after it moved.
- `enable -p` and `-d` turn no builtin off.
