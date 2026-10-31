## bash-gate@0.1.1

### Traps and prompt strings see what's defined after them

Trap actions, prompt strings and `PROMPT_COMMAND` are also walked with the state at the end of the script, so `trap 'f' EXIT; f() { rm -rf /; }` is denied.

### A process substitution no longer splits the word it's in

`v=<(f) rm -rf /` runs `rm` with `v` assigned, and `a<(f)` is one argument, as in Bash. The command was taken to be `<(f)`, so the deny rule for `rm` didn't apply and the gate asked instead of denying.

### `local` outside a function changes nothing

As in Bash, where it's an error. `x=-rf; local x=; rm $x /` is denied.

### A command word that may expand to nothing also runs the next word

`$x rm -rf /` is denied: with `$x` empty, Bash runs `rm`. It was only a command name known at run time, which asks.

### A name hashed in only some branches, to an unknown path, is a finding

After `if …; then :; else hash -p /bin/cat h; for i in 1; do hash -p /bin/rm h; done; fi`, `h` was taken to be a program named `h`. It's now a `loads-code` finding, which asks.

## bash-gate@0.1.0

### First release

Static analysis of Bash command lines for agent permission gates: `analyze` lists every program a command line can run, with its options, paths and effects, and `check` decides it under a policy of allow, ask and deny rules.

### The analysis

Variables, functions, aliases, loops, `cd`, wrappers (`env`, `xargs`, `sudo`, `timeout`, …), `bash -c`, `eval`, traps and code inside strings are followed as Bash runs them. Anything it can't follow becomes a dynamic argument or a finding, never a gap. Program specs read options the way each program does, including subcommands and options that run code (`git -c`, `find -exec`, `sed e`, `tar --to-command`, `ssh -o ProxyCommand`).

### Policies

Rules match commands, options, paths (as written, resolved, under `~`, and real paths through an optional `realpath`) and effects. A rule that only may match never allows. `recommended` allows reading and everyday git, denies force pushes and deleting top-level directories, and asks about the rest.

### Repository code

An optional `readFile` hook walks Git config and its includes, Git hooks, `ssh -F` config and npm lifecycle scripts as code. `THREAT_MODEL.md` states the promises and which tests check each, including runs against real Bash.
