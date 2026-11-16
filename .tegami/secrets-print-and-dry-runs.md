---
packages:
  'bash-gate': minor
---

### `secrets:print`: a secret that reaches the script's output whole

A new effect beside `secrets:read`, which stays as it is. An invocation that reads a secret also has `secrets:print`
when it copies what it reads unchanged, by a new spec property, `copies` (`cat`, `tac`, `head`, `tail`, `less`,
`more`, `bat`, `nl`, `strings`, `xxd`, `od`, `base64`, `tee`, and `echo` and `printf` of a secret variable), prints the
environment (`printenv`, `env` with no command, `export -p`, `set`, `declare -p`), or is a tool printing a secret of its
own (`kubectl get secret -o yaml`, `terraform output -json`, `helm get values`), and its standard output reaches the
script's: not redirected to a file, not piped into a program that doesn't copy it (`| wc -l`), not captured by `$(…)`
or `<(…)`. Redirections are replayed in order (`>&2` still reaches the output). Programs that transform what they read
(`grep`, `cut`, `sed`, `awk`, `jq`) don't print: `cut -d= -f1 .env` lists names.

### Dry runs are lowered the same way everywhere, and say what they rehearse

- A dry run's `effects` are the rehearsal's in every spec that knows one: it still reads and may run project code, but
  doesn't write, delete or run anything remotely, and `network` becomes `network:read` unless it still reaches a host the
  command names or may still push. `git push -n`, `git clean -n`, `git add|rm|mv|fetch -n`, `rsync -n`, `npm
  --dry-run`, `cargo publish --dry-run`, `gh pr create --dry-run`, kubectl's and helm's `--dry-run` and
  `terraform state mv|rm -dry-run` are; `--dry-run=false`, `=none` or a value only known at run time aren't.
- `Invocation.dryRun` is the real command a dry run rehearses: `{ text, shape, effects }`, the same command without the
  option, `git clean -f` for `git clean -n` (git's default `clean.requireForce`), and `terraform apply` with the same
  arguments, but those only a plan takes, for `terraform plan`.
- `CommandSpec.dryRun` names a program's dry-run options, which values make one, the real command, and what the
  rehearsal still does.

### `npm publish` runs its lifecycle scripts

`npm publish` and `pnpm publish` walk the scripts publishing runs (`prepublishOnly`, `prepack`, `prepare`, `postpack`,
`publish`, `postpublish`) and are `exec:project`, as `npm pack` is; another package's are `exec:file`. `bun publish` is
`exec:project`. rsync's `-n` is `--dry-run` (and `-a`, `-v` and the rest their long names).
