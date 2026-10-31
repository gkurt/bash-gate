## bash-gate@0.2.0

### Allow rules no longer match a path as written

`allow({ writes: ['src/**'] })` allowed `cd /tmp && echo x > src/a`: the path as written matched, though it's `/tmp/src/a`. Allow rules now match only forms that say where a path is: resolved, from where the script starts, and real.

### Files the script changes before reading them are unknown

Git config and hooks, npm scripts and SSH config the script may write first (`cp -r hooks .git/ && git commit`), or write while they're read (`&`, a pipeline), are an `unknown-file` finding rather than their old contents. So is the real path of anything under a symlink the script may create (`ln -s /etc e && rm e/passwd`).

### Relative globs match from the starting `cwd`, so `recommended` allows writes inside it

With `cwd: '/repo'`, `echo hi > out.txt` was asked about as a write outside the working directory. Relative globs now match paths from an absolute starting `cwd` (and its real path), and `recommended` asks about `..`, `../**` and `~/**` instead of `/**`. Without a starting `cwd`, an absolute path may match a deny or ask rule's relative glob.

### Traps set in a subshell or a child shell see what's defined after them

A trap runs when the shell that set it exits, so it's also walked with that shell's state at its end: `( trap 'f' EXIT; f() { rm -rf /; } )` is denied.

### `analyze` and `check` take one `Environment`, with a `FileSystem` that may not know

The `readFile` and `realpath` options are replaced by `fs: { readFile, realpath }`, where `null` is absent and `undefined` is unknown; `evaluate` takes no options. What it didn't know is an `unknown-file` finding and an entry in `analysis.needs`. `snapshot()` builds a `FileSystem` from records, and `checkAsync()` fetches the needs from an `AsyncFileSystem` over a few rounds.

### `recommended` asks about writes to `.git` and `.git/hooks` as a whole

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
