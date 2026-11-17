---
packages:
  'bash-gate': patch
---

### Globs judged by the pattern Bash matches, not the text as written

- **Brackets across a word's pieces:** an unquoted `[` and a later unquoted `]` that brace expansion or a variable's value puts in one word make a glob, as Bash globs the joined word. `cat {.en[,}v]` and `x=']'; cat .en[v$x` read `.env`, and `cp x {y,.gi[}t]/hooks` writes `.git/hooks`. Such a word is now a glob, not a literal path.
- **Secret files:** a glob's secret check uses the pattern Bash matches with, once braces and known variables are expanded. `x='.e*'; cat $x` and `y=.en; cat $y*` now ask, as `cat .e*` does. A glob with a part only known at run time (`read z; cat $z*`) may name any file its known end allows.
- **`Arg.pattern`:** a dynamic glob `Arg` has the pattern it matches with when every part of it is known.
