## bash-gate@0.3.0

### More places the parser and Bash disagree are parse errors

A here-document that's never closed, which in a substitution Bash ends elsewhere than the parser does; an array
assignment with text after it (`v=(…)x`), which Bash expands as a string where the parser sees no substitutions; a
process substitution after digits (`2>(…)`), which Bash runs and the parser read as text; a `${…}` the parser
couldn't read, such as `${a[$(f)}]}`, where Bash runs `f`; a `$` before a line continuation, which Bash joins to the
name after it; and an expansion that's never closed in a here-document or prompt string, which the parser closes
without an error. `cat a 2>(rm -rf /)` was allowed.

### A command whose redirection may fail may not run

Bash runs none of a command, or a `{ …; }` group, when it can't open one of its files, so what it would change may
stay as it was: `alias rm=true <missing` defines nothing, and `rm -rf /` after it was read as `true -rf /`.

### `set` and `shopt` read their options as Bash does

`set -eo posix`, `set -o -o posix` and `shopt -so posix` turn POSIX mode on, and with it aliases, which was missed:
`ls` defined as `rm -rf /` after any of them was allowed. Options end at the first word that isn't one (`set x -o
posix` sets positional parameters), and a bad letter or option name anywhere, or `shopt` with both `-s` and `-u`,
changes nothing.

### While an exec is checked, the rest of the supervised tree is stopped

Nothing in the tree can change the exec's arguments between the check and the kernel's copy of them.

### A clone with `CLONE_UNTRACED` fails under the supervisor

Its child would be no tracee: the supervisor couldn't stop it, and the run could end while it still ran.

### `hash` reads its options as Bash does

They end at the first name (`hash x -p /bin/true rm` gives `rm` no path), `-p` gives its path to every name, and a
name without `-p` is looked up on `PATH` again, forgetting the path it had. A name only known at run time is a
finding.

### A carriage return in code is a parse error

Git Bash (Bash on Windows) drops it from code it parses, where Bash on Linux and the parser keep it as part of a word: `cat <<'EOF'`
with a line `EOF\r` in the body, then `rm -rf /`, was allowed, and in Git Bash it runs `rm`.

### A shell that runs its startup files is a finding

`bash -i` reads `~/.bashrc` unless given `--norc`, and a login shell (`-l`, `--login`) reads `/etc/profile` and
`~/.profile` unless given `--noprofile`: code the analysis doesn't see, so an `exec-config` finding.

### `gh` has a spec

Its argv is read as cobra reads it, so `gh -R o/r pr merge` is `pr merge` with `--repo`, and each command gets its options and effects (API calls are `network`; `pr checkout` and `repo sync` run git hooks). Code gh runs is walked: shell aliases (`gh alias set x --shell …`), the editor, pager and browser in `gh config set`, the git flags `gh repo clone` passes to `git clone`, and the command `gh codespace ssh` runs. An unknown first word is an alias or extension, `exec:arbitrary`. `GH_PAGER`, `GH_EDITOR`, `GH_BROWSER`, `BROWSER`, `GH_CONFIG_DIR` and `GH_PATH` are sensitive variables.

### An array literal's subscript is expanded again once its quotes are gone

In `a=([subscript]=value)`, Bash removes the subscript's quotes and expands what's left: `a=(['$'('rm -rf /)']=1)` runs
`rm`, and was allowed.

### An alias whose text is only known at run time counts as unseen code

`covers` accounted for one program with one word in its place, but such an alias can run anything: arguments, other
commands, wrappers.

### The threat model assumes nothing writes between the analysis and the end of the run

An integration runs commands one at a time, each once everything the last one started has exited: a background job
from an earlier command could rewrite a hook after the next was checked. `bash-gate/trace` already waits for daemons.

### A shell option only known at run time may be `-c`

`bash $x 'rm -rf /'` runs `rm` when `$x` is `-c`: each of the shell's arguments is walked as code it may run, and one
only known at run time is a finding.

### No process under the supervisor holds `CAP_SYS_PTRACE`, root included

### A prompt string only known at run time is code the analysis doesn't see

`PS4` or `PROMPT_COMMAND` set to a value with a substitution in it was a `sensitive-variable` finding, which `covers`
doesn't count as unseen code; the substitutions in such a prompt run between commands. It's a `dynamic-script` finding
now.

### `read`, `mapfile`, `compgen`, `complete` and `enable` read their options as Bash does

Letters may share a word and a value may be attached: `mapfile -tC'rm -rf /' -c1 a` runs `rm` as its callback, which
was missed. Options end at the first word that isn't one. An `enable` argument only known at run time may be `-n` or
any builtin's name, so it's a `dynamic-command` finding.

### `declare -u`, `-l` and `-c` change the case of what a variable is assigned

`declare -l v; v=RM; $v -rf /` runs `rm`, and was read as `RM`. A `declare`, `local`, `export` or `readonly` with an
option Bash doesn't know changes nothing.

### A function's local variables are put back when it returns

`local`, and `declare` or `typeset` without `-g`, in a function kept their value after it: `x=/; f() { local x=./build; }; f; rm -rf $x`
was read as `rm -rf ./build`. A new local without a value is unset, and what the function starts sees the exported one
from outside. Options end at the first name, so `declare x -g y=1` is local.

### An alias that opens a here-document is a parse error

Its body is the lines after the command, which the parser reads as commands, so a `<<` among them hid the rest:
`alias c='cat <<EOF'`, then `c`, `<<D`, `EOF` and `rm -rf /` on their own lines, was allowed.

### Substitutions inside single quotes in arithmetic and here-documents run

Bash expands `$(( ))`, `(( ))`, subscripts and slice offsets as if double-quoted, where single quotes are only text:
`x=$(( '$(rm -rf /)' ))` runs `rm`, and was read as no command at all. So does `${y:-'$(rm -rf /)'}` in an unquoted
here-document, which was allowed.

### Trap actions and prompt strings are walked between every two commands

Once set, they're walked at each point they may run, with the state there, and what they change carries on: `f() { :; }; trap f ERR; f() { rm -rf /; }; false; f() { :; }` and `x=ls; trap 'x=rm' DEBUG; $x -rf /` no longer hide `rm`. `trap -- 'action' SIG` is walked, and `trap - SIG` resets it.

### A backslash and newline in `$'…'` are kept

They're no escape there, so Bash keeps both, where the parser dropped them: `$'a\` and a newline, then `b'`, is three
characters and a newline, not `ab`.

### An assignment of a process substitution replaces the variable's value

`x=ls; x=<(:); $x` kept `x` as `ls`; it's now only known at run time, as in Bash, where it's a `/dev/fd` path.

### `bash-gate/trace` runs a command under a supervisor that checks every exec against the analysis

`run(source, { mode })` runs the command in Bash with every `execve` in its process tree stopped by ptrace and seccomp. In `enforce` mode, one the shell or a wrapper it follows (`xargs`, `env`, `find -exec`) makes that the analysis didn't predict fails with EPERM before it runs; in `trace` mode it runs and is reported. x86_64 Linux, Node, and a C compiler to build the supervisor on first use. The coverage check is in the main entry too, as `covers` and `predicting`.

### Text after a process substitution in a redirection belongs to its target

`cat <<< <(f)x -n y` reads from one word, `<(f)x`, where the parser ended the target at the substitution and made `x`
an argument.

### A name `hash -p` gave a path may run from `PATH`

Bash looks the name up on `PATH` when the path isn't there, so `hash -p ./missing rm; rm -rf /` runs `rm`.

### A shell's here-document or here-string is walked as code

`bash <<'EOF'`, `sh -s x <<< 'code'`: what the shell reads from its standard input is followed like `bash -c`. A body
only known at run time, or other input (a pipe, a file, the caller's), is a `dynamic-script` finding. `-s` reads the
script from standard input, not from its first argument, and a lone `-` ends the options: `sh - <<< 'code'` reads it
too.

### What a wrapper starts is found on `PATH`, not in the shell's `hash -p` table

`hash -p /bin/true rm; env rm -rf /` was read as `env true -rf /`; `env`, `sudo`, `xargs` and the other wrappers now
run `rm`, as they do in Bash. The shell's own lookups, `command` and `exec` still use the table.

### Braces in `alias` and `declare` arguments are expanded

`alias l="ls -la"{x,y}` defines `l` twice, the last time as `ls -lay`, and `declare v=a{b,c}` sets `v` to `ac`. The
analysis kept the braces in the value.

### An alias ending in a blank reaches past quoted words

Bash doesn't expand a quoted word after it, but still checks the next one: with `alias s='sudo ' r='rm -rf /'`,
`s \env r` runs `sudo env rm -rf /`.

### A subcommand only known at run time may match a rule at every level under it

`git $x stash drop` no longer escapes `deny('git stash drop')`: a rule naming two subcommand levels may match, so it asks.

### git and npm subcommands are named as themselves

`git revert` was `cherry-pick` and `npm unpublish` was `publish`, so rules naming them never matched; only real aliases (`npm i`, `git remote rm`) share a name now. `npm tst`, `npm rum` and `npm restart`'s stop and start scripts are followed, and `git ls-remote` reaches the network.

### unbash 6.0.2

`$'…'` stops at its first NUL escape, as in Bash, and `<<` inside `${…}` no longer starts a here-document.

### Files a program may write without naming them are unknown to later reads

With `fs`, a git command that rewrites the work tree (`checkout`, `stash`, `reset`, `merge`…) makes everything in it but `.git` unknown, and a program without a spec, one running code the analysis doesn't follow (`make`, `npm install`, `python3 -c`), or one whose spec writes without saying where makes every later read unknown: `git checkout evil && npm test` no longer trusts the `package.json` read before the checkout.

### unbash 6.0.3

An empty `$''` and a here-string that is a process substitution (`cat <<< <(f)`) parse, so they're analysed rather
than asked about as parse errors.

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
