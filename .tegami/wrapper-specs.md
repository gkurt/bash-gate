---
packages:
  'bash-gate': patch
---

### Wrappers read their options as getopt does

Abbreviated long options take their value from the next word (`env --uns X cmd`, `timeout --sig KILL 5 cmd`), and an
option a spec doesn't know leaves where the command starts unknown.

### `env -S` splits its string into env's own arguments

`env -S'cmd a' b` runs `cmd a b`, and options and assignments in the string count. A lone `-` is `-i`, and any word
with an `=` before the command is an assignment, `PATH="$x"` too.

### A `case` arm after `;&` or `;;&` starts from what the arm before changed

### `xargs -I` and `find -execdir` follow their input

The replacement string in the command, its name too, is what each input line becomes, and `-execdir` runs the command
in a directory only known at run time.
