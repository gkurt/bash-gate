---
packages:
  'bash-gate': minor
---

### A shell's here-document or here-string is walked as code

`bash <<'EOF'`, `sh -s x <<< 'code'`: what the shell reads from its standard input is followed like `bash -c`. A body
only known at run time, or other input (a pipe, a file, the caller's), is a `dynamic-script` finding. `-s` reads the
script from standard input, not from its first argument, and a lone `-` ends the options: `sh - <<< 'code'` reads it
too.
