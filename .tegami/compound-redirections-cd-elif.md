---
packages:
  'bash-gate': patch
---

### A compound command's redirection writes even when nothing in it runs

`case a in b) ;; esac > .git/config`, `(( 0 )) > f` and `[[ 0 ]] > f` open the file, as `> f` alone does.

### A `cd` may fail, and the shell stays where it was

After `cd sub; cd ..`, the working directory is unknown: if `sub` isn't there, the second `cd` leaves the project. `&&`,
`||`, `!` and `if` say which way it went.

### An `else` sees what the `elif` clauses before it changed

`x=ls; if false; then :; elif x=rm; false; then :; else $x -rf /; fi` runs `rm`.
