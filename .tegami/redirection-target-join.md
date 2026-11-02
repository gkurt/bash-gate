---
packages:
  'bash-gate': patch
---

### Text after a process substitution in a redirection belongs to its target

`cat <<< <(f)x -n y` reads from one word, `<(f)x`, where the parser ended the target at the substitution and made `x`
an argument.
