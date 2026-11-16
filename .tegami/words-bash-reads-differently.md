---
packages:
  'bash-gate': patch
---

### ANSI-C `\x{…}`, signed and zero-padded brace sequences, `~+` after `PWD`, env's escapes, words that split into options, and exported temporary variables

Each of these was allowed while Bash did something else:

- `$'\x{2d}exec'` is `-exec`: Bash reads `\x{…}` as one byte from any number of hex digits, and the parser kept it as
  text.
- `-e{x..x..+1}ec` is `-exec`: a brace sequence's ends and step may have a `+` sign. Ends written with a leading zero
  pad every value (`{01..03}` is `01 02 03`), and a sequence too long to list is only known at run time.
- `~+` is `$PWD`, not the working directory, so setting `PWD` is a finding, as `HOME` is.
- `env -S` splits with escapes of its own (`\_` separates words), so a string with a backslash is only known at run
  time.
- A word that may split may hold options after its first field, whatever that starts with:
  `git log HEAD$(printf ' --output=f')`, and `find -name a$x` or `find -exec echo $x` with `x=' ; -delete'`.
- `a=rm export a` (and `declare -x`, `declare -r`, `readonly`) keeps `a` after the command. Exported from code `eval`
  or a function runs, the value is only known at run time: Bash 5.2 and 5.3 differ.
