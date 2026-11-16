---
packages:
  'bash-gate': patch
---

### Braces that are no list or sequence, and `BASH_VERSINFO`

- `{$x..}` is no sequence, so Bash keeps the braces as text but still expands, unquotes and splits what's between
  them: `x=' ../outside '; touch {$x..}` writes `../outside`. Such braces around anything but plain text are only
  known at run time. So is a letter sequence through the characters between `Z` and `a`.
- `BASH_VERSINFO` is read-only from the start: what's assigned to it isn't what it holds.
