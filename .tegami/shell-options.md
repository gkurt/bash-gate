---
packages:
  'bash-gate': patch
---

### Shell options that change what runs are followed

`lastpipe` keeps what a pipeline's last command assigns, `localvar_inherit` gives a local its outer value, `allexport`
exports variables and functions to the shells a script starts, and BASHOPTS or SHELLOPTS, exported, pass options on.
`set -P`, `cd -P` and `cdable_vars` leave the working directory unknown. A compatibility level, `set -k` and `set +B`
are `unknown-syntax` findings, and a shell's `+` options (`bash +B -c …`) no longer hide its code. An assignment before
a function or builtin is a variable while it runs, and `unset` in a function may show a caller's hidden value.
