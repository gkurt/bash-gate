---
packages:
  'bash-gate': patch
---

### Subscripts in names Bash reads, and prompt strings `${x@P}` expands

Bash expands the subscript in a name that `read`, `printf -v`, `wait -p`, `unset`, `test -v`, `[[ -v ]]`, `declare` or
`${!x}` reads, and in a variable's value used as arithmetic: `read 'a[$(rm -rf ~)]'` runs `rm`, and was allowed. So
does `${x@P}`, which expands x's value as a prompt string, after decoding octal escapes (`\044` is `$`, in `PS4` too).
A name only known at run time, and an arithmetic value only known at run time, now count as code unseen.
