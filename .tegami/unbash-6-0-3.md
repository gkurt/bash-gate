---
packages:
  'bash-gate': patch
---

### unbash 6.0.3

An empty `$''` and a here-string that is a process substitution (`cat <<< <(f)`) parse, so they're analysed rather
than asked about as parse errors.
