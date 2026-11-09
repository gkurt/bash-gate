## bash-gate@0.3.0

### `$'…'` in arithmetic is decoded before it's expanded, and a `#` inside a word starts no comment

Bash decodes ANSI-C quoting in arithmetic and subscripts, then expands what it holds: `$(( $'\x24(rm -rf /)' ))` runs
`rm`, which went unseen. And `x=<(cat a)#; rm -rf /` is one word and a command to Bash, where the parser read
`#; rm -rf /` as a comment: a `#` right after a word the parser ended is a parse error.

### A process substitution's aliases in POSIX mode, at parse time and at run time

In POSIX mode Bash expands a process substitution's aliases as its line is parsed, then again as it runs, so either
may be what runs: `alias ls="rm -rf /"; { alias ls=cat; cat <(ls); }` on separate lines runs `rm`.

### A blank-ending alias stops at an unquoted expansion, and a backslash in a default's inner quotes

After an alias whose text ends in a blank, Bash checks the next words for aliases past quoted ones, but not past one
with an unquoted expansion (`$x`, `$(…)`, `<(…)`). And in a default's inner quotes, Bash drops a backslash before what
it doesn't escape in double quotes: `"${v:-"$\(rm -rf /)"}"` runs `rm`.

### An alias whose text is only known at run time counts as unseen code

`covers` accounted for one program with one word in its place, but such an alias can run anything: arguments, other
commands, wrappers.

### `$'…'` in a quoted default or a here-document, and a variable's name across a line continuation

In a double-quoted `"${y:-$'…'}"` Bash decodes the `$'…'` and expands what it holds, so `"${y:-$'\x24(rm -rf /)'}"`
runs `rm`; in a here-document `$'` is no quoting at all, and the substitution after it runs. A subscript expanded again
decodes `$'…'` too. And a line continuation is gone before Bash reads a word, so `$x\` then a newline and `r` is `$xr`.

### Substitutions inside single quotes in arithmetic and here-documents run

Bash expands `$(( ))`, `(( ))`, subscripts and slice offsets as if double-quoted, where single quotes are only text:
`x=$(( '$(rm -rf /)' ))` runs `rm`, and was read as no command at all. So does `${y:-'$(rm -rf /)'}` in an unquoted
here-document, which was allowed.

### unbash 6.0.3

An empty `$''` and a here-string that is a process substitution (`cat <<< <(f)`) parse, so they're analysed rather
than asked about as parse errors.

### Trap actions and prompt strings are walked between every two commands

Once set, they're walked at each point they may run, with the state there, and what they change carries on: `f() { :; }; trap f ERR; f() { rm -rf /; }; false; f() { :; }` and `x=ls; trap 'x=rm' DEBUG; $x -rf /` no longer hide `rm`. `trap -- 'action' SIG` is walked, and `trap - SIG` resets it.

### `flock`'s lock file is a write

`flock FILE cmd` and `flock FILE -c CODE` create `FILE` when it's missing, so the lock file counts as written.

### A shell option only known at run time may be `-c`

`bash $x 'rm -rf /'` runs `rm` when `$x` is `-c`: each of the shell's arguments is walked as code it may run, and one
only known at run time is a finding.

### `$'…'` in a default inside `"$(…)"`, and an empty variable named across a line continuation

In a command substitution inside double quotes, Bash decodes a `$'…'` in a `${…}` operand and expands what it holds, so
`"$(echo ${y:-$'\x24(rm -rf /)'})"` runs `rm`. And an empty variable whose name runs across a line continuation is no
word, where it was read as an empty one.

### POSIX mode is followed as Bash follows it

`set` applies its options one at a time, as Bash does: `set -o[ posix` turns POSIX mode on before it fails at `[`.
Entering POSIX mode turns `expand_aliases` on and leaving turns it off, but `set -o posix` when it's already on
changes nothing; assigning `POSIXLY_CORRECT` always enters it, and unsetting it always leaves. In POSIX mode a
substitution Bash only parses as it runs, in a here-document or in text it expands again, gets no aliases.

### Files a program may write without naming them are unknown to later reads

With `fs`, a git command that rewrites the work tree (`checkout`, `stash`, `reset`, `merge`…) makes everything in it but `.git` unknown, and a program without a spec, one running code the analysis doesn't follow (`make`, `npm install`, `python3 -c`), or one whose spec writes without saying where makes every later read unknown: `git checkout evil && npm test` no longer trusts the `package.json` read before the checkout.

### An array literal's subscript is expanded again once its quotes are gone

In `a=([subscript]=value)`, Bash removes the subscript's quotes and expands what's left: `a=(['$'('rm -rf /)']=1)` runs
`rm`, and was allowed.

### `hash` reads its options as Bash does

They end at the first name (`hash x -p /bin/true rm` gives `rm` no path), `-p` gives its path to every name, and a
name without `-p` is looked up on `PATH` again, forgetting the path it had. A name only known at run time is a
finding.

### A function name with quotes defines nothing, and double quotes in arithmetic

Bash refuses to define `'r'm() { :; }` or `\rm() { :; }`: `rm` still runs the program, where it was read as the
function. And arithmetic is also walked with its double quotes gone, as a subscript Bash expands again has them gone.

### Inner quotes in a here-document's default

As in a double-quoted string, Bash removes the inner quotes in a here-document's `${u:-"$"("cmd)"}` before expanding
it, so `cmd` runs; so does arithmetic, which is expanded the same way.

### Subscripts in names Bash reads, and prompt strings `${x@P}` expands

Bash expands the subscript in a name that `read`, `printf -v`, `wait -p`, `unset`, `test -v`, `[[ -v ]]`, `declare` or
`${!x}` reads, and in a variable's value used as arithmetic: `read 'a[$(rm -rf ~)]'` runs `rm`, and was allowed. So
does `${x@P}`, which expands x's value as a prompt string, after decoding octal escapes (`\044` is `$`, in `PS4` too).
A name only known at run time, and an arithmetic value only known at run time, now count as code unseen.

### While an exec is checked, the rest of the supervised tree is stopped

Nothing in the tree can change the exec's arguments between the check and the kernel's copy of them.

### A clone with `CLONE_UNTRACED` fails under the supervisor

Its child would be no tracee: the supervisor couldn't stop it, and the run could end while it still ran.

### unbash 6.0.2

`$'…'` stops at its first NUL escape, as in Bash, and `<<` inside `${…}` no longer starts a here-document.

### No process under the supervisor holds `CAP_SYS_PTRACE`, root included

### A `$"…"` string in arithmetic is unknown syntax

Bash translates `$"…"` as it parses arithmetic, and what that leaves with the expansions around it, read again as a
subscript, can run code (`(( a[$"$"$@""(cmd)] = 1 ))`): it's an `unknown-syntax` finding.

### An array literal's subscript is expanded twice

Bash expands `a=([$k]=1)`'s subscript, then expands what that leaves again, so `k='$(rm -rf /)'` runs `rm`: what a
known value leaves is walked, and one only known at run time is a `dynamic-script` finding, as it may be any code.

### Words the parser reads differently from Bash fail closed

Bash closes a brace only after a comma: `{a}s,d}` is `a}s d`, which the parser read as text. A word whose braces Bash
expands differently from the parser is now only known at run time. A word with quotes or substitutions the parser
kept as plain text (`ls[ $(rm -rf /) ]''`, one word to Bash, which runs the substitution) is a parse error.
`compgen -C` runs its code as a substitution, so in POSIX mode without aliases.

### `break`, `continue` and `return` skip the rest of a loop or function

What holds at each counts after the loop or call: in `f() { x=rm; return; x=ls; }; f; $x -rf /`, `$x` is `rm`.

### An arithmetic `for` loop's test and update see what the body changed

They run again after each pass, so a subscript the body assigns is expanded.

### Inner quotes in a default, in pairs and in `$"…"`

Bash removes the inner quotes of a default in pairs, `$"…"` ones included, so `"${u:-$"""$"("rm -rf /)"}"` runs `rm`;
and it does the same in a `$"…"` string as in a double-quoted one.

### An assignment removes the quotes in a glob, and an unquoted value is a pattern

`x=a['q']` stores `a[q]`, as in Bash, so `x=[';rm -rf /;']; eval "$x"` runs `rm`; the quotes were kept. A known
value used unquoted is matched against files as a written glob is: `x='*'; cat $x` is a glob, no longer the word `*`.

### A shell's here-document or here-string is walked as code

`bash <<'EOF'`, `sh -s x <<< 'code'`: what the shell reads from its standard input is followed like `bash -c`. A body
only known at run time, or other input (a pipe, a file, the caller's), is a `dynamic-script` finding. `-s` reads the
script from standard input, not from its first argument, and a lone `-` ends the options: `sh - <<< 'code'` reads it
too.

### Declare's bad names, a builtin's temporary environment, and process substitutions in POSIX mode

`declare y!=d` is no name to Bash, which refuses it and leaves `y` as it was. What a builtin or function assigns to a
variable it was given for the call (`z=a read z`) is gone after it unless it went global, so it's only known at run
time. And in POSIX mode a process substitution has the aliases defined when it runs, unlike a command substitution.

### Braces in `alias` and `declare` arguments are expanded

`alias l="ls -la"{x,y}` defines `l` twice, the last time as `ls -lay`, and `declare v=a{b,c}` sets `v` to `ac`. The
analysis kept the braces in the value.

### A lone `$` keeps a word whole, and a backslash ending the code is a parse error

Bash doesn't split a word with a `$` in it that starts no expansion: with `x='a b'`, `$x-$` is the one word `a b-$`.
A backslash that ends the code is kept by Bash, or dropped after a quoted string over several lines, so it's counted
as a parse error.

### `bash-gate/trace` runs a command under a supervisor that checks every exec against the analysis

`run(source, { mode })` runs the command in Bash with every `execve` in its process tree stopped by ptrace and seccomp. In `enforce` mode, one the shell or a wrapper it follows (`xargs`, `env`, `find -exec`) makes that the analysis didn't predict fails with EPERM before it runs; in `trace` mode it runs and is reported. x86_64 Linux, Node, and a C compiler to build the supervisor on first use. The coverage check is in the main entry too, as `covers` and `predicting`.

### Shell options that change what runs are followed

`lastpipe` keeps what a pipeline's last command assigns, `localvar_inherit` gives a local its outer value, `allexport`
exports variables and functions to the shells a script starts, and BASHOPTS or SHELLOPTS, exported, pass options on.
`set -P`, `cd -P` and `cdable_vars` leave the working directory unknown. A compatibility level, `set -k` and `set +B`
are `unknown-syntax` findings, and a shell's `+` options (`bash +B -c …`) no longer hide its code. An assignment before
a function or builtin is a variable while it runs, and `unset` in a function may show a caller's hidden value.

### A command after `nice --` that starts with a dash is unknown

uutils' `nice` rewrites `-n N` into `-nN` even after `--`, so `nice -- -n 1 cmd` runs `-n1` there and `-n` in GNU's.

### An alias named across a line continuation, declare's unseen braces, and where a lone `$` stops splitting

A line continuation is gone before Bash looks for an alias, so `l\` and a newline then `s` runs the alias `ls`. A
`declare` argument whose braces Bash expands but the parser didn't see (`d=(a){b,c}`) is only known at run time. And a
lone `$` keeps a word from splitting only when no unquoted expansion comes after it: `$x$/$x` still splits.

### A command whose redirection may fail may not run

Bash runs none of a command, or a `{ …; }` group, when it can't open one of its files, so what it would change may
stay as it was: `alias rm=true <missing` defines nothing, and `rm -rf /` after it was read as `true -rf /`.

### An assignment of a process substitution replaces the variable's value

`x=ls; x=<(:); $x` kept `x` as `ls`; it's now only known at run time, as in Bash, where it's a `/dev/fd` path.

### What a wrapper starts is found on `PATH`, not in the shell's `hash -p` table

`hash -p /bin/true rm; env rm -rf /` was read as `env true -rf /`; `env`, `sudo`, `xargs` and the other wrappers now
run `rm`, as they do in Bash. The shell's own lookups, `command` and `exec` still use the table.

### More places the parser and Bash disagree are parse errors

A here-document that's never closed, which in a substitution Bash ends elsewhere than the parser does; an array
assignment with text after it (`v=(…)x`), which Bash expands as a string where the parser sees no substitutions; a
process substitution after digits (`2>(…)`), which Bash runs and the parser read as text; a `${…}` the parser
couldn't read, such as `${a[$(f)}]}`, where Bash runs `f`; a `$` before a line continuation, which Bash joins to the
name after it; and an expansion that's never closed in a here-document or prompt string, which the parser closes
without an error. `cat a 2>(rm -rf /)` was allowed.

### Backquotes have their run-time aliases in POSIX mode

Bash parses backquotes as they run, like a process substitution, so in POSIX mode they get the aliases defined then,
even inside a `$(…)` that has its line's: `{ alias ls="rm -rf /"; x=$(echo \`ls\`); }`on separate lines runs`rm`.

### A shell that runs its startup files is a finding

`bash -i` reads `~/.bashrc` unless given `--norc`, and a login shell (`-l`, `--login`) reads `/etc/profile` and
`~/.profile` unless given `--noprofile`: code the analysis doesn't see, so an `exec-config` finding.

### `shopt` reads its options as Bash does

A lone `-` ends them and is a name, so `shopt - -s expand_aliases` turns nothing on, and a word with a letter Bash
rejects (`-s-`) changes nothing. Both were read as `shopt -s expand_aliases`, which made the analysis expand aliases
Bash didn't.

### The threat model assumes nothing writes between the analysis and the end of the run

An integration runs commands one at a time, each once everything the last one started has exited: a background job
from an earlier command could rewrite a hook after the next was checked. `bash-gate/trace` already waits for daemons.

### A function is read in the code it was defined in, wherever it's called from

A function called from a trap or `eval` was read against the caller's code, so `trap f EXIT; f() { x=$(( '$(rm -rf /)'
)); }` missed `rm`. A `declare` word only known at run time that may be an option leaves the variables it names
unknown, as Bash may reject it. And braces Bash expands differently from the parser are a parse error, as they may
multiply the substitutions in the word.

### Text after a process substitution in a redirection belongs to its target

`cat <<< <(f)x -n y` reads from one word, `<(f)x`, where the parser ended the target at the substitution and made `x`
an argument.

### An alias ending in a blank reaches past quoted words

Bash doesn't expand a quoted word after it, but still checks the next one: with `alias s='sudo ' r='rm -rf /'`,
`s \env r` runs `sudo env rm -rf /`.

### A subcommand only known at run time may match a rule at every level under it

`git $x stash drop` no longer escapes `deny('git stash drop')`: a rule naming two subcommand levels may match, so it asks.

### Substitutions' aliases in POSIX mode, inner quotes in a quoted default, and names running out of braces

In POSIX mode Bash runs a command substitution as it parsed it with the line around it, so with that line's aliases
and none it defines itself: `{ alias rm=true; x=$(rm -rf /); }` on separate lines runs `rm`. In
`"${u:-"$"("rm -rf /)"}"` Bash removes the inner quotes before expanding, and runs `rm`. And braces expand before any
expansion in the word, so `{$,}s` is `$s s`.

### Wrappers read their options as getopt does

Abbreviated long options take their value from the next word (`env --uns X cmd`, `timeout --sig KILL 5 cmd`), and an
option a spec doesn't know leaves where the command starts unknown.

### `env -S` splits its string into env's own arguments

`env -S'cmd a' b` runs `cmd a b`, and options and assignments in the string count. A lone `-` is `-i`, and any word
with an `=` before the command is an assignment, `PATH="$x"` too.

### A `case` arm after `;&` or `;;&` starts from what the arm before changed

### `xargs -I` and `find -execdir` follow their input

The replacement string in the command, its name too, is what each input line becomes, and `-execdir` runs the command
in a directory only known at run time.

### An `env -S` string uutils reads differently leaves the command unknown

uutils' env splits only `-S`, `-vS`, `-vvS` and `--split-string` as spelled, before the first word that isn't an option,
and never again in what it split. Any other `-S`, such as `--split cat` or `-iScat`, it ignores, so the command
depends on which env runs it.

### A compound command's redirection writes even when nothing in it runs

`case a in b) ;; esac > .git/config`, `(( 0 )) > f` and `[[ 0 ]] > f` open the file, as `> f` alone does.

### A `cd` may fail, and the shell stays where it was

After `cd sub; cd ..`, the working directory is unknown: if `sub` isn't there, the second `cd` leaves the project. `&&`,
`||`, `!` and `if` say which way it went.

### An `else` sees what the `elif` clauses before it changed

`x=ls; if false; then :; elif x=rm; false; then :; else $x -rf /; fi` runs `rm`.

### A prompt string only known at run time is code the analysis doesn't see

`PS4` or `PROMPT_COMMAND` set to a value with a substitution in it was a `sensitive-variable` finding, which `covers`
doesn't count as unseen code; the substitutions in such a prompt run between commands. It's a `dynamic-script` finding
now.

### `set` and `shopt` read their options as Bash does

`set -eo posix`, `set -o -o posix` and `shopt -so posix` turn POSIX mode on, and with it aliases, which was missed:
`ls` defined as `rm -rf /` after any of them was allowed. Options end at the first word that isn't one (`set x -o
posix` sets positional parameters), and a bad letter or option name anywhere, or `shopt` with both `-s` and `-u`,
changes nothing.

### `gh` has a spec

Its argv is read as cobra reads it, so `gh -R o/r pr merge` is `pr merge` with `--repo`, and each command gets its options and effects (API calls are `network`; `pr checkout` and `repo sync` run git hooks). Code gh runs is walked: shell aliases (`gh alias set x --shell …`), the editor, pager and browser in `gh config set`, the git flags `gh repo clone` passes to `git clone`, and the command `gh codespace ssh` runs. An unknown first word is an alias or extension, `exec:arbitrary`. `GH_PAGER`, `GH_EDITOR`, `GH_BROWSER`, `BROWSER`, `GH_CONFIG_DIR` and `GH_PATH` are sensitive variables.

### An alias that opens a here-document is a parse error

Its body is the lines after the command, which the parser reads as commands, so a `<<` among them hid the rest:
`alias c='cat <<EOF'`, then `c`, `<<D`, `EOF` and `rm -rf /` on their own lines, was allowed.

### Braces expand before variables

Bash expands `$x{a,b}` to `$xa $xb`, so the variable's name runs into each alternative; it was read as `$x` followed
by `a` or `b`. `x=./build; xr=/; rm -rf $x{r,}` removes `/`.

### A carriage return in code is a parse error

Git Bash (Bash on Windows) drops it from code it parses, where Bash on Linux and the parser keep it as part of a word: `cat <<'EOF'`
with a line `EOF\r` in the body, then `rm -rf /`, was allowed, and in Git Bash it runs `rm`.

### `declare -u`, `-l` and `-c` change the case of what a variable is assigned

`declare -l v; v=RM; $v -rf /` runs `rm`, and was read as `RM`. A `declare`, `local`, `export` or `readonly` with an
option Bash doesn't know changes nothing.

### A backslash and newline in `$'…'` are kept

They're no escape there, so Bash keeps both, where the parser dropped them: `$'a\` and a newline, then `b'`, is three
characters and a newline, not `ab`.

### A name `hash -p` gave a path may run from `PATH`

Bash looks the name up on `PATH` when the path isn't there, so `hash -p ./missing rm; rm -rf /` runs `rm`.

### A function's local variables are put back when it returns

`local`, and `declare` or `typeset` without `-g`, in a function kept their value after it: `x=/; f() { local x=./build; }; f; rm -rf $x`
was read as `rm -rf ./build`. A new local without a value is unset, and what the function starts sees the exported one
from outside. Options end at the first name, so `declare x -g y=1` is local.

### `read`, `mapfile`, `compgen`, `complete` and `enable` read their options as Bash does

Letters may share a word and a value may be attached: `mapfile -tC'rm -rf /' -c1 a` runs `rm` as its callback, which
was missed. Options end at the first word that isn't one. An `enable` argument only known at run time may be `-n` or
any builtin's name, so it's a `dynamic-command` finding.

### A dynamic word may split where a known value in it does

`"$(cmd)"$x` with `x='a b'` is two words in Bash, but was read as one, so `covers` missed the run that got two.

### An array literal's subscript closes where Bash closes it

Brackets in a subscript nest: Bash reads `b=([a[1]=1); # $(cmd) ]=2)` as one element, whose subscript runs `cmd`, where
the parser ended it at the first `]` and read the rest as a comment. A subscript that doesn't close where the parser
ended it is a parse error, and one that does is read up to its matching `]`.

### Bash's own variables, namerefs and `command_not_found_handle` are followed

`BASH_ALIASES` and `BASH_CMDS` change the alias and `hash` tables, and a nameref (`declare -n`) or a variable named only
at run time may assign any variable: each was allowed before. Variables Bash sets itself (`RANDOM`, `PWD`,
`PIPESTATUS`, `_`…) are unknown whatever was assigned. `${x:=v}`, `printf -vNAME`, `wait -p`, `compgen -V`,
`exec {fd}>`, `coproc` and `select` assign, `unset` may remove a function, and `unset PATH`, `local PATH` and
`EXECIGNORE` are `sensitive-variable` findings. `command_not_found_handle` is walked for each program, and `fc`,
`set -H` and `history -w` are followed as running or writing history.

### git and npm subcommands are named as themselves

`git revert` was `cherry-pick` and `npm unpublish` was `publish`, so rules naming them never matched; only real aliases (`npm i`, `git remote rm`) share a name now. `npm tst`, `npm rum` and `npm restart`'s stop and start scripts are followed, and `git ls-remote` reaches the network.

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
