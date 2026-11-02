---
packages:
  'bash-gate': patch
---

### Substitutions inside single quotes in arithmetic and here-documents run

Bash expands `$(( ))`, `(( ))`, subscripts and slice offsets as if double-quoted, where single quotes are only text:
`x=$(( '$(rm -rf /)' ))` runs `rm`, and was read as no command at all. So does `${y:-'$(rm -rf /)'}` in an unquoted
here-document, which was allowed.
