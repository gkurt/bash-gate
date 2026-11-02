---
packages:
  'bash-gate': patch
---

### A prompt string only known at run time is code the analysis doesn't see

`PS4` or `PROMPT_COMMAND` set to a value with a substitution in it was a `sensitive-variable` finding, which `covers`
doesn't count as unseen code; the substitutions in such a prompt run between commands. It's a `dynamic-script` finding
now.
