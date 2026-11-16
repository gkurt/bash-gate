---
packages:
  'bash-gate': patch
---

### Special builtins in POSIX mode, alias and unset options, attributes unset takes away, locals that may not be, PS4 with a temporary environment, pushd's stack, and functions a child shell gets

Each of these was allowed while Bash ran something else:

- In POSIX mode (`set -o posix`, or `POSIXLY_CORRECT` before the command) a special builtin (`eval`, `exec`,
  `export`…) is found before a function of the same name. `POSIXLY_CORRECT=1` before a special builtin leaves POSIX
  mode on.
- `alias` and `unalias` read their options as getopt does: `alias -- -x=…` defines `-x`, `unalias -- -a` removes no
  alias, and one Bash refuses (`alias /bin/rm=…`) defines nothing. An alias named after a reserved word (`fi`, `{`)
  is a finding, as Bash expands it where the analysis doesn't. `unalias` with a name only known at run time may
  remove any.
- `unset -f -v` unsets nothing, and `unset` takes away the integer and case attributes. `declare +i` takes the
  integer one away, and an integer attribute given on one way only may not be there.
- `declare -r` and `readonly` are a finding: later assignments and `unset` leave the variable as it is.
- `local -I` starts with the value outside. A `local` that may not have run, `declare -g` beside a local, and `unset`
  of a caller's local leave the variable only known at run time after the call.
- PS4 is walked between a statement's assignments and with a command's temporary environment in place.
- `pushd` with no directory, `+N` or `-N` goes to a directory only known at run time, and `pushd -n` stays.
- `declare -fx` exports a function, and `export -nf`, `declare +x -f` and `unset -f` take it back. A shell that may
  not be Bash (`sh`, a hook, a package script) may run the program instead of an exported function, and
  `env BASH_FUNC_name%%=…` is a finding.
