## bash-gate@0.5.0

### git's patch and edit modes open the editor, and biome with a word only known at run time may write or delete

- These open the editor (`exec:arbitrary`), which `vi` makes scriptable from the script's input:
  - `git add -p`, `-i` and `-e`;
  - `git commit -p` and `--interactive`;
  - `git stash -p`, and `stash push -p` or `save -p`.
- A biome command only known at run time is now `exec:arbitrary`. Before, it had no effects at all: `biome "$(echo format)" --write ../x` and `xargs biome` were allowed, although `format --write` rewrites files and `clean` deletes.
- Under `check`, `lint`, `format` and `migrate`, a word that may be `--write` counts as one.

### A `+` case attribute turns off its letter in either order, and a tilde in an assignment-shaped argument is expanded

- `declare +u -u x=…` no longer upper-cases what it's assigned. Bash turns each letter given with `+` off, whatever the order: `+u -u` leaves the value as it is, and `+u -l` still lower-cases. The analysis upper-cased it, so `declare +u -u o=-c; git $o core.fsmonitor=… status` was allowed although git ran the fsmonitor command.
- A tilde after the `=` or a `:` of an argument shaped like an assignment (`echo a=~/x`, `declare x=a:~/b`) is now only known at run time, because Bash expands it there too.

### A project .npmrc's script-shell is a program of its own

With a filesystem, the project's `.npmrc` is read before npm or pnpm runs package scripts.

When it names another `script-shell`, the scripts run with that program instead of `sh`, so they aren't walked as shell code:

- a program named by path or name is `exec:file`, and a read of that program;
- one that comes from the environment (`${VAR}`) is `exec:arbitrary`.

An `.npmrc` the script may have changed before it's read is a finding, as `package.json` is. A snapshot that leaves `.npmrc` unknown now asks; give it as `null` when it isn't there.

### A program the analysis can't place covers only its own call

`covers` and `bash-gate/trace` treated every invocation that shared a `loads-code` finding's span as "any program, from anywhere". Code from a string (`bash -c`, `eval`, `trap`) and a wrapper's command share one span. So `bash -c '(exec -a k pgrep a); cat notes'` covered `rm notes`, and `hash -p "$P" find; find . -exec ls {} +` covered `rm -rf /` under `find`. Enforce mode would have run them.

That's now a field of the invocation itself: `Invocation.unplaced`. It covers that one call only. It's set for `exec -a`, a name `hash -p` gave a path only known at run time, and a git that runs a hook the analysis can't read.

### Files named by an option's value, and more ways awk, gh and bun read secrets or write outside

`secrets:read` now covers secret files named this way:

- **Option values:** the value of an option the spec doesn't know (`git blame --contents=.env`, `git add --pathspec-from-file=.env`, `wc --files0-from=.env`), and a `git -c` config value (`-c blame.ignoreRevsFile=.env`). The program reads these files, and prints them or their lines in an error.
- **Spec fixes:**
  - `git blame` and `annotate` know `--contents` and `--ignore-revs-file`.
  - `git log` knows `-L`.
  - GNU diff's `-d` and `-f` and util-linux column's `-d` and `-L` take no value. They had hidden the file that followed them.
  - `file -f` and `-m`, and `diff --from-file` and `--to-file`, are reads.
- **Index stages:** `git show :0:.env` (a stage of the index).
- **awk:** `SYMTAB`, `PROCINFO` and `ARGV`/`ARGC` in an awk program.
- **gh:** a `--jq` filter that reads the environment.

Also:

- bun's `--cpu-prof-name`, `--cpu-prof-dir`, `--heap-prof-name` and `--heap-prof-dir` are writes to the path they name.
- `core.protectNTFS` and `core.protectHFS` are git config keys that can lead to code running.

### FileSystem takes just-bash's and Node's shape, each method optional and sync or async

`fs` can be a just-bash `IFileSystem` or Node's `fs` functions as they are: `readFile(path, 'utf8')`, `readFileBuffer`, `readdir`, `realpath` and `lstat`. An `ENOENT`, `ENOTDIR` or `EISDIR` error means nothing is there, and `lstat` tells a dangling symlink from nothing. `check` throws a `TypeError` on a promise, and `checkAsync` takes the same `FileSystem`. `AsyncFileSystem` is gone, and `snapshot` takes `buffers` and gives only the methods whose records it's given.

### Repositories nested in a work tree that git looks into

git looks into every repository its index records as a gitlink, even one `.gitmodules` doesn't name, and runs its `core.fsmonitor`. The analysis reads the gitlinks from `.git/index` (versions 2 to 4). A command that checks out another commit, or one after git may have changed the index, looks into every repository in the work tree, found with `readdir`. Where neither can be read, the git invocation has the new effect `exec:nested`, which `recommended` allows.

### Paths with a newline, credential directories read whole, and more of the user's configuration

- **Newlines in paths:** a `**` in a policy glob now matches a newline, as do the secret file patterns. A path such as `$'../x\ny'` had escaped every `**` rule (`../**`, `.git/**`, `~/.ssh/**`), and `$'a\nb.pem'` wasn't seen as a key.
- **Credential directories:** a directory that holds credentials (`~/.ssh`, `~/.aws`, `~/.config`) is a secret read when a program may read it recursively (`grep -r '' ~/.aws`).
- **More secret files:** `credentials.json`, `secrets.yaml`/`.yml`/`.json`, `.yarnrc.yml`, and shell history.
- **terraform:** a word only known at run time after the command may be `-out`, `-state-out`, `-var-file`, `-or-create` or `-net-mirror`. It now counts as a write, a read and network.
- **The user's configuration:** `recommended` asks before writes anywhere under `~/.config`, `~/.local` and `~/.cargo`, even from a script started in HOME. That covers Python's `.pth` files, gh's and pnpm's config, and editors'. It also asks about `.bashrc.d`, oh-my-zsh, nvm, bun, Yarn, Claude, AWS, Docker, terraform, GnuPG, vim, tmux, `.pam_environment`, `.xprofile` and macOS launch agents.

### git checkout of a file, rebase --onto, reads through a descriptor, and system writes from /

- **`git checkout WORD`:** with a filesystem, this restores a file or directory of that name over uncommitted changes when no branch, tag, remote branch or ref has the name. It now counts as `--force`, which `recommended` asks about.
- **`git rebase --onto`:** asks, since it drops the commits it leaves out.
- **Descriptor reads:** a file `exec` opened on a descriptor is read by a later `<&N` (`exec 3< .env; cat <&3`), and by every command that inherits standard input opened that way (`exec < .env; cat`). The shell state follows copies (`4<&3`), closes and reopens.
- **System writes:** `recommended` asks before writes to `/usr`, `/bin`, `/sbin`, `/lib`, `/etc` and `/boot`, even from a script started at `/`. A program written to `/usr/local/bin` would otherwise be trusted as the system's.

### grep, and sed, awk or jq that may pass a line through, print the secrets they read

`secrets:print` now covers four more programs, read directly or through a pipe:

- **grep:** prints the lines it matches whole (`grep KEY .env`, `env | grep TOKEN`), unless it only tests, counts or names files (`-q`, `-c`, `-l`, `-L`).
- **sed, awk and jq:** print a secret when their script may pass a line or value through unchanged:
  - sed without `-n`, or with a command that prints (`sed 's/^export //' .env`, `sed -n '/KEY/p' .env`);
  - an awk program that uses a field, prints with no arguments, or has a pattern with no action (`awk -F= '{print $2}'`, `awk '/KEY/'`);
  - a jq filter with a path or a variable in it (`jq .auths`).

These stay read but not printed:

- programs that can't pass a line through: `awk '{print length}'`, `jq length` and `sed -i`;
- `cut`, `wc`, `tr` and `sort`'s keys.

### bun's command is the first word without a dash, and pnpm's `--color` takes `always`, `auto` or `never`

- bun picks its command as the first word that doesn't start with `-`, without skipping any option's value. When that word names a bun command but the spec read it as an option's value, the command is now `exec:arbitrary` and `network`. Before, `bun --title create test` was allowed as `bun test` although it runs `bun create`, which fetches and runs a package. `bun --cwd add test left-pad` was likewise allowed as `bun test`, but runs `bun add`.
- pnpm's `--color` takes `always`, `auto` or `never` from the next word, as its nopt types say. Before, `pnpm --color never exec rm -rf ../victim` was read as running the project's `never` script.
- A spec option's new `words` field names those values.

### secrets:print follows a secret through variables, pipes and output sent back

`secrets:print` now marks more of the ways a secret reaches the script's output whole:

- a variable assigned it, read into it or looped over it, and a substitution that read it (`x=$(cat .env); echo "$x"`, `echo "$(cat .env)"`);
- a pipe into a wrapper, function, loop, group, path-named or unknown program, any of which may pass it on (`| env cat`, `| while read l; do echo "$l"; done`), or a `tee` onto `/dev/stderr` mid-pipe;
- output sent back from a capture on purpose (`x=$(cat .env >&2)`, `>&3`, `> >(cat)`, `/proc/self/fd/1`, `/dev/pts/0`);
- `set -x` tracing an expanded secret;
- `hexdump`, `rev`, `sort`, `uniq`, `paste`, `join`, `diff`, `comm`, `zcat`, `dd` without `of=`, `cp` onto `/dev/stdout`, and `git show`, `cat-file` and `diff`.

Only a secret's length or a part of it (`${#GITHUB_TOKEN}`, `${x:0:4}`, `${x//?/*}`) no longer counts as printed. Neither does closed standard output (`1<&-`), and `.env.local.example`-style templates no longer count as secrets.

### A nameref or attribute on `_`, `PWD` or `OLDPWD`, or an attribute through a nameref, is a finding

Bash assigns `_`, `PWD` and `OLDPWD` itself, through a nameref and with the attributes they have. These were allowed and changed what ran:

- `declare -n _=x` makes each command's last word `x`'s value: `x=ls; declare -n _=x; : rm; $x -f f` runs `rm`.
- `declare -n OLDPWD=x` lets `cd` assign `x`.
- `declare -i _` evaluates each last word as arithmetic, command substitutions in subscripts included.
- `declare -l PWD` lowers what `~+` reads.

An attribute given to a nameref (`declare -n r=v; declare -i r`) goes to the variable it names. All of these are now `sensitive-variable` findings.

### Nested submodules, husky under a hooks path ending in `..`, and more of the user's startup files

- **Nested submodules:** with a filesystem, a submodule's own submodules are followed too. `git status` in the top repository runs a nested submodule's `core.fsmonitor`.
- **husky hooks paths:** a husky 9 stub under a `core.hooksPath` that ends in `.` or `..` (`.husky/x/..`) is a finding. husky's dispatcher works out the project's hook from the path's text, so it runs `.husky/x/pre-commit`, not the hook the folded path leads to.
- **The user's startup files:** `recommended` now asks before writes to more files that run code later, even from a script started in HOME:
  - husky's init scripts (`~/.config/husky/init.sh`, `~/.huskyrc`), which every hook it runs sources;
  - fish's, systemd's, `environment.d`'s and autostart's configuration under `~/.config`;
  - `~/.cargo/bin`, which is on PATH.

### kubectl, helm and terraform: dry runs that aren't, and more they print, fetch or write

- A dry run doesn't count when the command has an option its spec doesn't know, or a word that may be one: it may take the dry-run option as its value (`kubectl run --detach-keys --dry-run=client`).
- A `kubectl --raw` request ignores the dry run.
- These print secrets:
  - `kubectl config view` with or without `--raw`;
  - `kubectl -v=8` and up on a Secret;
  - a helm install or upgrade dry run with `--reuse-values` or `=server`, unless `--hide-secret` is given.
- These reach the network:
  - a URL in a comma-separated `-f` or `--values`;
  - a kustomization named by host (`github.com/org/repo`, `deploy@host:repo`);
  - `terraform workspace select -or-create`.
- `helm repo index` and `dependency build|update` write into the directory they're given.
- `recommended` asks about writes under `~/.kube`.

### Dry runs only where the program honors them, and only when the real command they name is the same

- npm's `--dry-run` lowers only the commands that honor it: `install`, `ci`, `update`, `uninstall`, `dedupe`, `prune`, `link`, `pack`, `publish` and `unpublish`. npm ignores it elsewhere, and `npm --dry-run run deploy`, `dist-tag add`, `owner add`, `version` and `pkg set` were allowed as rehearsals although they run for real.
- A command whose words without the dry-run option would read as another command is no dry run. In `git clean -n -fen -x`, one `n` is `-e`'s value, so `invocation.dryRun` named a different command.
- A plugin or a subcommand the spec doesn't know gets no `dryRun`.
- `git fetch --dry-run` keeps `fs:write`, because it still stores the objects it downloads.
- helm's `--dependency-update` writes into the chart, dry run or not.

### A file named only at run time may be a secret's

A path only known at run time now counts as `secrets:read` when the program reads it. It may come from a substitution, input, a variable or the script's arguments: `cat $(echo .env)`, `read f; cat "$f"`, `find . -name .env | xargs cat`, `find ~/.ssh -exec cat {} +`, `cat "$1"`. Hiding a secret's name no longer turns an ask into an allow.

It doesn't count when the known end of the name rules a secret out (`cat "$name.ts"`), or for a loop over a static glob that matches no secret (`for f in src/*.ts; do cat "$f"; done`). `xargs grep TODO < list` now asks.

## bash-gate@0.4.0

### kubectl, helm and terraform ask when a dry run is off, a Secret is printed, or a host is their own

kubectl, helm and terraform ask in more of the cases that change, print or reach something:

- helm's `--dry-run=false` (or `0`), which Go reads as a real run;
- `kubectl config view --flatten`;
- a percent-encoded `kubectl get --raw` path;
- upper-case output formats, and a Secret printed by any kubectl command with `-o` (`label`, `annotate`, `wait`);
- `helm status -o json`;
- helm repositories from `--repository-config`, `--repository-cache` or `XDG_CACHE_HOME`/`XDG_DATA_HOME`;
- `terraform init -migrate-state`, `-force-copy` or `-backend-config=KEY=VALUE`;
- `terraform fmt -check=false`, which writes;
- `terraform providers lock -net-mirror`.

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

### More ways a secret is copied, printed or reached are `secrets:read`

`secrets:read` catches more ways a secret reaches output: a secret variable copied by an assignment, a loop's words, `${!x}` or a nameref; evaluated as arithmetic or tested as a number, whose error prints it; matched into `BASH_REMATCH`; or tested under `set -x`. It also catches `ps e` anywhere in its arguments and `ps -E`, awk's `ENVIRON`, jq's `env` and `$ENV`, yq's `env()` and `strenv()`, globs that may match a credentials file (`.e?v`, `~/.aws/*`), a secret file renamed with `mv` or `ln`, `git show HEAD:.env`, a redirection through a link, thread environments under `/proc`, and more credentials files and variable names (`PGPASSWORD`, `MYSQL_PWD`, `GITHUB_PAT`). `PASSWORD_STORE_DIR`, `NEXT_PUBLIC_…_KEY`, `${TOKEN:+set}` and source files like `.env.ts` no longer count.

### More ways Bash shows a secret are `secrets:read`

`secrets:read` catches more ways Bash shows a secret:

- `declare -px NAME` and other `-p` clusters, and `local -p`;
- a prompt string that expands one (`PS4` under `set -x`, `${x@P}`);
- names evaluated as arithmetic: subscripts, offsets, `[[ X -eq 0 ]]`, integer variables, and a variable whose value names a secret;
- `[ … ]` forms whose error prints their words, and `test`, which leaves its last word in `$_`;
- globs under `dotglob` or `GLOBIGNORE`;
- `git config --file`;
- yq's `load…()` and jq's `import`.

`git ls-files .env`-style commands that only name a file, `cp .env.example .env`, token counts like `MAX_TOKENS`, and jq's `{env: …}` keys no longer count.

## bash-gate@0.3.0

### An alias ending in a blank reaches past quoted words

Bash doesn't expand a quoted word after it, but still checks the next one: with `alias s='sudo ' r='rm -rf /'`,
`s \env r` runs `sudo env rm -rf /`.

### A blank-ending alias stops at an unquoted expansion, and a backslash in a default's inner quotes

After an alias whose text ends in a blank, Bash checks the next words for aliases past quoted ones, but not past one
with an unquoted expansion (`$x`, `$(…)`, `<(…)`). And in a default's inner quotes, Bash drops a backslash before what
it doesn't escape in double quotes: `"${v:-"$\(rm -rf /)"}"` runs `rm`.

### An alias named across a line continuation, declare's unseen braces, and where a lone `$` stops splitting

A line continuation is gone before Bash looks for an alias, so `l\` and a newline then `s` runs the alias `ls`. A
`declare` argument whose braces Bash expands but the parser didn't see (`d=(a){b,c}`) is only known at run time. And a
lone `$` keeps a word from splitting only when no unquoted expansion comes after it: `$x$/$x` still splits.

### An alias that opens a here-document is a parse error

Its body is the lines after the command, which the parser reads as commands, so a `<<` among them hid the rest:
`alias c='cat <<EOF'`, then `c`, `<<D`, `EOF` and `rm -rf /` on their own lines, was allowed.

### An alias's text is read as Bash reads it, a word at a time

After an alias whose text ends in a blank, Bash checks the next word for an alias, and keeps checking through that
alias's own text: its first word is expanded too, and so on. The analysis put the second alias's text in place
without that, so with `alias cat="env "` and `alias l="cat rm"`, `cat l -rf /` was `env cat rm -rf /`, reading files,
and allowed: Bash runs `env env rm -rf /`.

An alias also isn't expanded again only while Bash reads its own text. The analysis held it back for the rest of the
command, so in `a a`, with `alias a="ls;"`, the second `a` was a program; Bash expands it again.

### `$'…'` in a quoted default or a here-document, and a variable's name across a line continuation

In a double-quoted `"${y:-$'…'}"` Bash decodes the `$'…'` and expands what it holds, so `"${y:-$'\x24(rm -rf /)'}"`
runs `rm`; in a here-document `$'` is no quoting at all, and the substitution after it runs. A subscript expanded again
decodes `$'…'` too. And a line continuation is gone before Bash reads a word, so `$x\` then a newline and `r` is `$xr`.

### A backslash and newline in `$'…'` are kept

They're no escape there, so Bash keeps both, where the parser dropped them: `$'a\` and a newline, then `b'`, is three
characters and a newline, not `ab`.

### A NUL in `$'…'` ends it past a backslash and newline

`$'/\c a\`, a newline, then `b'` is `/` in Bash: `\c ` is a NUL, which ends the string. The analysis decoded the text
on either side of the backslash and newline apart, so it read `/` with a backslash, a newline and `b`, and
`rm -rf` with it asked instead of being denied.

### Words `xargs` appends are read with the command line

`echo 'rm -rf /' | xargs env` was allowed: the words `xargs` adds were counted after the command was read, so a wrapper given no command ran them unseen, and `xargs cp payload` or `xargs tee` wrote files no rule saw. They're now read as the rest are: as the command a wrapper runs, an option, or a file written.

### A word that may be several before a wrapper's command leaves the command unknown

`timeout $(cat list)` and `nice -n $(cat list)` were allowed, though the words may hold the command itself. So is a word that may be an option before `timeout`'s duration.

### More git checkout forms, `fetch --stdin`, `cp --parents` and `sed -i` backups

- `recommended` asks about `git checkout -- <path>`, `-m` and `--conflict` (which check out paths as merged),
  `-2` and `-3` (git's `--ours` and `--theirs`), and `--pathspec-from-file`, all of which overwrite local changes.
  `Parsed.separated` says whether `--` ended the options.
- `git fetch --stdin` reads refspecs that may force or prune local branches, so it counts as `--force`.
- `cp --parents` writes each source under the target by its whole path, `..` and all.
- `sed -i`'s backup is written too: the suffix after the file's name, or with a `*`, a path of its own.

### nopt's `true` and `false`, find's `-` and `,`, `uniq +N`, and bun's timings file

- npm and pnpm read a `true` or `false` after a flag as its value (`pnpm --color false exec …`), as nopt does; a
  `CommandSpec` says so with `nopt`. A word only known at run time there may be one.
- find takes `-` alone, and `)` or `,` first, as paths, which `-delete` deletes.
- `uniq +N in out` writes `out`: `+N` is the old spelling of `-s N`.
- `bun test --timings <file>` takes the next word, and with `--update-timings` rewrites that file.

### Options are read as the programs' own parsers read them

- `CommandSpec.dashless`: an option's value is never a separate word starting with `-`, which is read as an option
  instead, as mri, cac, minimist, yargs and nopt's strings do. pnpm, vite, vitest, tsdown, prettier and jest are read
  so: `pnpm -C --config.script-shell=x test` sets the script shell, `vite -m dev -m --host` listens on the network.
- tsc's flags take a `true` or `false` after them: `tsc --noEmit false x.ts` emits.
- `cargo clippy --` passes its words to rustc: anything but lint levels (`-D warnings`) may run a linker or write.
- `git push --no-verify --veri` turns the hook back on: a duplicate entry kept `--veri` from being read as `--verify`.
  Duplicates in the tar, rsync, strace and biome specs are gone too, and `gh repo read-file|read-dir` take `-R`.

### More options and commands read as the programs read them

- `git stash list` takes log options: its `--output` is a write.
- `tsc @file` reads more options from the file, which may write anywhere: it asks.
- nopt (npm, pnpm) splits `-C=dir` at the `=`, and reads a word of shorthands letter by letter (`npm -Cd ls` is
  `npm info ls`): such a cluster is an unknown option.
- Where a valued option meets a word starting with `-` (pnpm, vite, vitest, tsdown, prettier, jest), either reading is
  taken: some options take it, and the words after may be options.
- `bun up` is `bun update`; pnpm's `purge`, `uni`, `dislink`, `clean-install` (`ic`, `install-clean`), `peers`,
  `owners`, `undeprecate`, `prefix`, `set-script` (`ss`), `change`, `lane` and `pack-app` are its own commands, not
  scripts.

### `$'…'` in arithmetic is decoded before it's expanded, and a `#` inside a word starts no comment

Bash decodes ANSI-C quoting in arithmetic and subscripts, then expands what it holds: `$(( $'\x24(rm -rf /)' ))` runs
`rm`, which went unseen. And `x=<(cat a)#; rm -rf /` is one word and a command to Bash, where the parser read
`#; rm -rf /` as a comment: a `#` right after a word the parser ended is a parse error.

### A `$"…"` string in arithmetic is unknown syntax

Bash translates `$"…"` as it parses arithmetic, and what that leaves with the expansions around it, read again as a
subscript, can run code (`(( a[$"$"$@""(cmd)] = 1 ))`): it's an `unknown-syntax` finding.

### Substitutions inside single quotes in arithmetic and here-documents run

Bash expands `$(( ))`, `(( ))`, subscripts and slice offsets as if double-quoted, where single quotes are only text:
`x=$(( '$(rm -rf /)' ))` runs `rm`, and was read as no command at all. So does `${y:-'$(rm -rf /)'}` in an unquoted
here-document, which was allowed.

### An array literal's subscript is expanded again once its quotes are gone

In `a=([subscript]=value)`, Bash removes the subscript's quotes and expands what's left: `a=(['$'('rm -rf /)']=1)` runs
`rm`, and was allowed.

### An assignment removes the quotes in a glob, and an unquoted value is a pattern

`x=a['q']` stores `a[q]`, as in Bash, so `x=[';rm -rf /;']; eval "$x"` runs `rm`; the quotes were kept. A known
value used unquoted is matched against files as a written glob is: `x='*'; cat $x` is a glob, no longer the word `*`.

### Words the parser reads differently from Bash fail closed

Bash closes a brace only after a comma: `{a}s,d}` is `a}s d`, which the parser read as text. A word whose braces Bash
expands differently from the parser is now only known at run time. A word with quotes or substitutions the parser
kept as plain text (`ls[ $(rm -rf /) ]''`, one word to Bash, which runs the substitution) is a parse error.
`compgen -C` runs its code as a substitution, so in POSIX mode without aliases.

### Braces expand before variables

Bash expands `$x{a,b}` to `$xa $xb`, so the variable's name runs into each alternative; it was read as `$x` followed
by `a` or `b`. `x=./build; xr=/; rm -rf $x{r,}` removes `/`.

### Braces that are no list or sequence, and `BASH_VERSINFO`

- `{$x..}` is no sequence, so Bash keeps the braces as text but still expands, unquotes and splits what's between
  them: `x=' ../outside '; touch {$x..}` writes `../outside`. Such braces around anything but plain text are only
  known at run time. So is a letter sequence through the characters between `Z` and `a`.
- `BASH_VERSINFO` is read-only from the start: what's assigned to it isn't what it holds.

### Sequences with whitespace before a number, and steps past 64 bits

Bash reads a sequence's numbers past the whitespace before them, which an unquoted word holds as `\v` or `\f`:
`$y{\v1..1}` is `$y1`. Such a brace, and one whose step is too big to hold, is only known at run time.

### `read`, `mapfile`, `compgen`, `complete` and `enable` read their options as Bash does

Letters may share a word and a value may be attached: `mapfile -tC'rm -rf /' -c1 a` runs `rm` as its callback, which
was missed. Options end at the first word that isn't one. An `enable` argument only known at run time may be `-n` or
any builtin's name, so it's a `dynamic-command` finding.

### A carriage return in code is a parse error

Git Bash (Bash on Windows) drops it from code it parses, where Bash on Linux and the parser keep it as part of a word: `cat <<'EOF'`
with a line `EOF\r` in the body, then `rm -rf /`, was allowed, and in Git Bash it runs `rm`.

### A compound command's redirection writes even when nothing in it runs

`case a in b) ;; esac > .git/config`, `(( 0 )) > f` and `[[ 0 ]] > f` open the file, as `> f` alone does.

### A `cd` may fail, and the shell stays where it was

After `cd sub; cd ..`, the working directory is unknown: if `sub` isn't there, the second `cd` leaves the project. `&&`,
`||`, `!` and `if` say which way it went.

### An `else` sees what the `elif` clauses before it changed

`x=ls; if false; then :; elif x=rm; false; then :; else $x -rf /; fi` runs `rm`.

### `break`, `continue` and `return` skip the rest of a loop or function

What holds at each counts after the loop or call: in `f() { x=rm; return; x=ls; }; f; $x -rf /`, `$x` is `rm`.

### An arithmetic `for` loop's test and update see what the body changed

They run again after each pass, so a subscript the body assigns is expanded.

### Braces in `alias` and `declare` arguments are expanded

`alias l="ls -la"{x,y}` defines `l` twice, the last time as `ls -lay`, and `declare v=a{b,c}` sets `v` to `ac`. The
analysis kept the braces in the value.

### `declare -u`, `-l` and `-c` change the case of what a variable is assigned

`declare -l v; v=RM; $v -rf /` runs `rm`, and was read as `RM`. A `declare`, `local`, `export` or `readonly` with an
option Bash doesn't know changes nothing.

### Declare's bad names, a builtin's temporary environment, and process substitutions in POSIX mode

`declare y!=d` is no name to Bash, which refuses it and leaves `y` as it was. What a builtin or function assigns to a
variable it was given for the call (`z=a read z`) is gone after it unless it went global, so it's only known at run
time. And in POSIX mode a process substitution has the aliases defined when it runs, unlike a command substitution.

### `recommended` allows the tools project scripts run

`tsc`, `tsgo`, `biome`, `oxlint`, `oxfmt`, `eslint`, `prettier`, `vitest`, `jest`, `tsdown` and `vite` have specs and
run, so a script made of them is allowed with a filesystem. They still ask when they write outside the working
directory (`prettier --write ~/x`, `tsc --outDir ../x`, in any case tsc reads), delete (`tsc -b --clean`), or listen
beyond this machine (`vite --host`).

### `tsc` and `biome` write only files of their kinds

After `tsc`, only what it emits (`.js`, `.d.ts`, `.map`, `.tsbuildinfo`) is unknown, and after `biome` only what it
formats, so `tsc && git commit` still reads the hooks. The tools that load JavaScript configuration may still write
anything.

### A pipeline's commands don't change what each other read before them

A read in a pipeline was unknown after anything the script wrote, the reader's own later writes included, so
`npm test | tail` asked whenever the test script ran something unspecified. Now only the pipeline's other commands
count, and with `&` or `<(…)` the rest of the script.

### `git worktree list` runs

`git worktree` has its subcommands: `list` writes nothing, `add` checks out where it says and runs post-checkout.

### A prompt string only known at run time is code the analysis doesn't see

`PS4` or `PROMPT_COMMAND` set to a value with a substitution in it was a `sensitive-variable` finding, which `covers`
doesn't count as unseen code; the substitutions in such a prompt run between commands. It's a `dynamic-script` finding
now.

### A subcommand only known at run time may match a rule at every level under it

`git $x stash drop` no longer escapes `deny('git stash drop')`: a rule naming two subcommand levels may match, so it asks.

### env's lone `-` is `-i` only right after its options

`env -- X=1 - cmd` runs a program named `-`, as GNU's env reads `-` as `-i` only where its options end. The analysis
took it as `-i` after the assignment too, and predicted `cmd`.

### While an exec is checked, the rest of the supervised tree is stopped

Nothing in the tree can change the exec's arguments between the check and the kernel's copy of them.

### A clone with `CLONE_UNTRACED` fails under the supervisor

Its child would be no tracee: the supervisor couldn't stop it, and the run could end while it still ran.

### A command whose redirection may fail may not run

Bash runs none of a command, or a `{ …; }` group, when it can't open one of its files, so what it would change may
stay as it was: `alias rm=true <missing` defines nothing, and `rm -rf /` after it was read as `true -rf /`.

### Where writes land, and what hooks and scripts run

Each of these was allowed while the command wrote outside the project, into `.git`, or ran something else:

- `echo x > link/../passwd`, with `link` a symlink out of the project: a `..` after a symlink leads up from where it
  points, as the kernel resolves it.
- `echo hi > .GIT/hooks/pre-commit`: a rule's `.git` matches any case, as on a filesystem that ignores it.
- `cp -r /tmp/x/.git .` and `cp -t . /tmp/x/.git` write `./.git`: into a directory, each source lands under its own
  name, and a directory's contents (`x/.`) under names only known at run time. `cp -l` makes the source itself
  writable through the copy, so it counts as written.
- A git hook is read as the shell its first line names, `sh` when there's none, and a hook in another language is a
  finding. Hooks and package scripts run by `sh` expand aliases.
- A repository further up than 16 directories is a finding, not none at all.
- `git mv`, `git restore` and `git checkout` write the paths they're given, which may be outside the working directory.

### Hooks, shebangs, symlinked directories and case are read as git and the kernel read them

- A git command's hooks are read again once they've all been walked: a hook that writes another (`pre-commit` writing
  `reference-transaction`, which git runs after it) or the dispatcher husky's stubs source is a finding.
- A hook's first line counts only when it names a system shell, with no options but `set`'s (`#!/bin/sh -e`), or the
  shell `env` finds with nothing else: `env -S …`, `bash -i` or a shell elsewhere is a finding.
- `git -C`, `--git-dir`, `--work-tree` and `env -C` resolve `link/..` as the kernel does, from where the symlink leads.
- A write in another case (`.HUSKY/pre-commit`, `PACKAGE.JSON`) counts as a write to the file git or npm reads later.
- A `~` path with HOME unknown is never asked of the `FileSystem`: it's a finding.

### `flock`'s lock file is a write

`flock FILE cmd` and `flock FILE -c CODE` create `FILE` when it's missing, so the lock file counts as written.

### A function's local variables are put back when it returns

`local`, and `declare` or `typeset` without `-g`, in a function kept their value after it: `x=/; f() { local x=./build; }; f; rm -rf $x`
was read as `rm -rf ./build`. A new local without a value is unset, and what the function starts sees the exported one
from outside. Options end at the first name, so `declare x -g y=1` is local.

### A function name with quotes defines nothing, and double quotes in arithmetic

Bash refuses to define `'r'm() { :; }` or `\rm() { :; }`: `rm` still runs the program, where it was read as the
function. And arithmetic is also walked with its double quotes gone, as a subscript Bash expands again has them gone.

### Redirections on a function call

The redirections on a call to a shell function (`f > ../x`, `f >> ~/.bashrc`, `f < /dev/tcp/…`) are judged, as they
would be on `:`: the function's body was, command by command, but what the call itself opens wasn't.

### A function is read in the code it was defined in, wherever it's called from

A function called from a trap or `eval` was read against the caller's code, so `trap f EXIT; f() { x=$(( '$(rm -rf /)'
)); }` missed `rm`. A `declare` word only known at run time that may be an option leaves the variables it names
unknown, as Bash may reject it. And braces Bash expands differently from the parser are a parse error, as they may
multiply the substitutions in the word.

### `gh` has a spec

Its argv is read as cobra reads it, so `gh -R o/r pr merge` is `pr merge` with `--repo`, and each command gets its options and effects (API calls are `network`; `pr checkout` and `repo sync` run git hooks). Code gh runs is walked: shell aliases (`gh alias set x --shell …`), the editor, pager and browser in `gh config set`, the git flags `gh repo clone` passes to `git clone`, and the command `gh codespace ssh` runs. An unknown first word is an alias or extension, `exec:arbitrary`. `GH_PAGER`, `GH_EDITOR`, `GH_BROWSER`, `BROWSER`, `GH_CONFIG_DIR` and `GH_PATH` are sensitive variables.

### Hooks are followed in the directory `core.hooksPath` names

With a filesystem, a repository whose config sets `core.hooksPath` (husky does) had every git command ask. The hooks there are now read like those in `.git/hooks`, and the finding stays only where the directory isn't certain: a relative path with `--git-dir` or `--work-tree`, `~` without a known `HOME`, or a path set in a conditional include.

### Every git command is checked for the hooks it runs

`git status` runs `post-index-change`, any ref update `reference-transaction`, `git restore` `post-checkout` and `git pull` the hooks of a merge and a rebase: none were read. A command the table doesn't have, or an alias, is checked for every hook.

### A hook defined in git config is code

Recent gits (2.55 does) run `hook.<name>.command` on the event `hook.<name>.event` names, so `git -c hook.x.command=… -c hook.x.event=reference-transaction branch b` ran a command `recommended` allowed. `config.worktree` is read with the repository's config too.

### Git's config and hooks are read from the repository git takes

With a filesystem, only `<root>/.git/config` was read. Git also takes the directory `--git-dir` or `--bare` names, and any directory that has a `HEAD`, `objects` and `refs` itself, so `git --git-dir=r status` and `cd r; git fetch o` ran the `core.fsmonitor` and `core.sshCommand` of a directory made by hand, unseen. A `.git` git doesn't take (one with only a `config`) no longer hides the repository above it. `--work-tree` is where git's rewrites of the work tree count.

### `recommended` asks about any write inside a `.git`, and to a file named `HEAD`

Without a filesystem that is what stops a repository made by hand. Writes to `.git/info` or a submodule's `.git/modules/*/config` were allowed.

### A name `hash -p` gave a path may run from `PATH`

Bash looks the name up on `PATH` when the path isn't there, so `hash -p ./missing rm; rm -rf /` runs `rm`.

### `hash` reads its options as Bash does

They end at the first name (`hash x -p /bin/true rm` gives `rm` no path), `-p` gives its path to every name, and a
name without `-p` is looked up on `PATH` again, forgetting the path it had. A name only known at run time is a
finding.

### Inner quotes in a here-document's default

As in a double-quoted string, Bash removes the inner quotes in a here-document's `${u:-"$"("cmd)"}` before expanding
it, so `cmd` runs; so does arithmetic, which is expanded the same way.

### `recommended` asks about the user's own configuration from HOME too

Writes to `~/.gitconfig`, `~/.config/git/`, `~/.ssh/` and the shell startup files (`~/.bashrc`, `~/.profile`, `~/.zshrc`
and the like) ask even when the script starts in HOME, where `..` doesn't reach them: git and the shell run what they
say later.

### Hooks husky wrote are followed to the project's own

husky's stub sources its dispatcher by a computed path (`. "$(dirname "$0")/h"`), so with a filesystem every git
command that runs a hook asked in a husky repository. A stub and dispatcher that are exactly what husky 9.0 or 9.1
writes are now followed to `.husky/<hook>`, and the line husky 7 and 8 put at a hook's top (`. "$(dirname -- "$0")/_/husky.sh"`)
is left out when its helper is husky's. `git commit` is judged by `.husky/pre-commit`, and runs nothing when there's
none. A husky file changed by hand is walked as it is, which asks.

### The JavaScript tools load only what the analysis sees

`vitest`, `jest`, `vite` and `tsdown` had no options in their specs, and run, so `vitest --globalSetup=/tmp/x.ts` was
allowed. Each now knows its options, and one it doesn't know is `exec:arbitrary`: cac and yargs take it as
configuration, which may load a module, in either camelCase or kebab-case. What loads code from the command line is
`exec:file`: a configuration file named there, jest's setup files, transforms and runners, and a reporter, pool,
environment, formatter, parser or plugin given by its path. `tsdown --on-success` is walked as shell code. Servers
(`vitest --ui`, `--api`, `--inspect`) are `network`, and `eslint --init` and `--inspect-config`, which fetch and run a
package, are `network` and `exec:arbitrary`. `vite`'s root, another project's, is `exec:file`.

### A dynamic word may split where a known value in it does

`"$(cmd)"$x` with `x='a b'` is two words in Bash, but was read as one, so `covers` missed the run that got two.

### Inner quotes in a default, in pairs and in `$"…"`

Bash removes the inner quotes of a default in pairs, `$"…"` ones included, so `"${u:-$"""$"("rm -rf /)"}"` runs `rm`;
and it does the same in a `$"…"` string as in a double-quoted one.

### A lone `$` keeps a word whole, and a backslash ending the code is a parse error

Bash doesn't split a word with a `$` in it that starts no expansion: with `x='a b'`, `$x-$` is the one word `a b-$`.
A backslash that ends the code is kept by Bash, or dropped after a quoted string over several lines, so it's counted
as a parse error.

### `matchRule` matches one rule against one invocation

A gate that maps invocations to actions of its own, rather than to allow, ask and deny, can match them with the same three-valued rules a policy uses: `matchRule(deny('gh pr merge'), invocation, analysis)` is 0 (no), 1 (maybe) or 2 (yes). `Tri` and `Start` are exported with it.

### Subscripts in names Bash reads, and prompt strings `${x@P}` expands

Bash expands the subscript in a name that `read`, `printf -v`, `wait -p`, `unset`, `test -v`, `[[ -v ]]`, `declare` or
`${!x}` reads, and in a variable's value used as arithmetic: `read 'a[$(rm -rf ~)]'` runs `rm`, and was allowed. So
does `${x@P}`, which expands x's value as a prompt string, after decoding octal escapes (`\044` is `$`, in `PS4` too).
A name only known at run time, and an arithmetic value only known at run time, now count as code unseen.

### An array literal's subscript closes where Bash closes it

Brackets in a subscript nest: Bash reads `b=([a[1]=1); # $(cmd) ]=2)` as one element, whose subscript runs `cmd`, where
the parser ended it at the first `]` and read the rest as a comment. A subscript that doesn't close where the parser
ended it is a parse error, and one that does is read up to its matching `]`.

### `network:read`: `recommended` allows `git fetch`, `git ls-remote` and the `gh` commands that only read

A new effect for reading from a host already set up. `git fetch` and `git ls-remote` have it when the remote is given by its name or not at all, and so do gh's commands that look (`gh pr view`, `gh pr checks`, `gh run view`, `gh issue list`, `gh search`, `gh repo view` and the like). They keep `network` once the command line may say where to go: a URL or a path, `git -c`, `--git-dir`, `gh -R HOST/OWNER/REPO`, `--web`, an argument only known at run time, or an option the spec doesn't know.

**Breaking:** these commands no longer have `network`, so a rule naming `network` no longer matches them. Name `network:read` too to keep asking.

### A forced fetch asks

`git fetch --force`, `--refmap`, `--update-head-ok`, `--prune-tags` and a `+` refspec move or delete local refs.

### `git remote add`, `set-url`, `rename`, `remove`, `set-head` and `set-branches` write `.git/config`

`git remote set-url origin https://example.com/x.git` was allowed by `recommended`, and decides where a later fetch or push goes.

### `git ls-remote --upload-pack` is `exec:arbitrary`

It had no options in its spec, so the program it runs was an unknown option.

### `GH_HOST`, `GH_REPO` and proxy variables are sensitive

`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (and lowercase) send a program's requests through a host the command line chooses.

### A command after `nice --` that starts with a dash is unknown

uutils' `nice` rewrites `-n N` into `-nN` even after `--`, so `nice -- -n 1 cmd` runs `-n1` there and `-n` in GNU's.

### No process under the supervisor holds `CAP_SYS_PTRACE`, root included

### The threat model assumes nothing writes between the analysis and the end of the run

An integration runs commands one at a time, each once everything the last one started has exited: a background job
from an earlier command could rewrite a hook after the next was checked. `bash-gate/trace` already waits for daemons.

### Options as the programs read them: git's, pflag's `-o=value`, xargs, watch, touch, cp, rg and `POSIXLY_CORRECT`

Each of these was allowed while the program did something else:

- `git --attr-source`, `--shallow-file` and `--super-prefix` take the next word, which isn't the subcommand.
- `git config set key value` and `git config --comment hi key value` set `key`: the subcommand and the value options
  of `git config` are read, and unsetting or renaming writes the config file as setting does. `git config -e` runs
  an editor.
- `git reflog expire`, `delete` and `drop` delete entries, a stash among them.
- `git blame`, `annotate`, `shortlog`, `rev-list`, `whatchanged`, `reflog` and `stash show` write `--output`.
- `git branch -M` and `-C` force, as `-D` does.
- `git commit -Sn` is `-S` with the key `n`, and `--verify` after `--no-verify` runs the hooks again.
- A Go program's `-o=value` (cobra's pflag) has the value `value`.
- `xargs --max-lines` takes a value only after `=`, and `watch -d` takes one attached.
- `touch -m` is a flag, so the word after it is a file to write.
- `cp` and `mv` know `--sparse`, `--no-preserve` and their other options. With one they don't know, any operand may
  be the target.
- `rg --hostname-bin` runs a program.
- `POSIXLY_CORRECT` makes GNU programs stop reading options at the first operand: setting it, or a program run with
  it in its environment, is a finding. Bash starts in POSIX mode with it in the environment.

### `recommended` allows package scripts, tests and builds

The README said `recommended` didn't ask about project code (`exec:project`), but no rule allowed `npm test`. It now
allows what `npm`, `pnpm`, `bun` and `cargo` run of the project (`npm test`, `pnpm lint`, `bun typecheck`,
`cargo build`), as it does git hooks, and still asks when they install, publish, delete, or run code the analysis
can't place.

### Specs for pnpm, bun and cargo

- pnpm and `bun run` run a command from PATH when no script has the name (`pnpm node -e …`): that command is
  walked like a wrapper's, unless the filesystem shows the script is there. `bun lint` runs `lint.ts` when no script
  is named `lint`.
- Inline code (`bun -e`), preloaded modules, a debugger, `bunx`, `pnpm dlx` and cargo's `--config` and `-Z` are
  `exec:arbitrary`, `exec:file` or `network`. A word cargo doesn't know runs the program `cargo-<word>`.
- With `fs`, the package.json scripts pnpm and bun run are walked as npm's are, `pre` and `post` scripts included.
  A workspace's scripts (`--filter`, `-r`) aren't followed. Without a package.json where the command runs, one above
  it may be used: an `exec-config` finding.

### npm reads more like npm

- A word npm doesn't know is the start of one of its commands' names (`npm exe` runs `npm exec`), and an option it
  doesn't know is configuration that may name the shell scripts run in (`--script-shell`): both are
  `exec:arbitrary`. So is `npm config set`.
- `npm pkg set` and `npm version` write the package.json, so scripts read after them are unknown. `npm version` and
  `npm pack` run scripts, and npm's other commands have their effects (`edit`, `explore`, `docs`, `cache`…).
- A package.json without `scripts` runs none, where it used to be an `exec-config` finding.

### More places the parser and Bash disagree are parse errors

A here-document that's never closed, which in a substitution Bash ends elsewhere than the parser does; an array
assignment with text after it (`v=(…)x`), which Bash expands as a string where the parser sees no substitutions; a
process substitution after digits (`2>(…)`), which Bash runs and the parser read as text; a `${…}` the parser
couldn't read, such as `${a[$(f)}]}`, where Bash runs `f`; a `$` before a line continuation, which Bash joins to the
name after it; and an expansion that's never closed in a here-document or prompt string, which the parser closes
without an error. `cat a 2>(rm -rf /)` was allowed.

### `/dev/tcp`, `checkout -p`, cargo's `--logfile`, workspace selectors, and project code after git rewrote the tree

- A redirection to Bash's `/dev/tcp/host/port` or `/dev/udp/…` is `network`, and so is one only known at run time.
- `git checkout -p` discards the hunks it's told to, and asks as `restore -p` does.
- `cargo test -- --logfile <file>` (and `bench`) writes that file.
- `npm -w`, `pnpm --filter` and `-w`, `bun --filter`, and cargo's `-p`, `--workspace` and `--exclude` run another
  package's code: `exec:file`, unless the value is a path inside the project.
- Without a filesystem, project code run after git rewrote the work tree is `exec:file`, as with one.

### Writes to the user's configuration are caught however they're spelled

- `~` globs also match a write's real path and where HOME really is (`Analysis.realhome`): a symlink to `~/.bashrc`, or
  HOME given by a path that leads to the start.
- A rule that may match is tried on the path in lower case too: `~/.BASHRC`, `~/.SSH/…` on a filesystem that ignores case.
- A `cwd` that isn't a POSIX absolute path (`C:/w/p`, `p`) places nothing, as no `cwd` doesn't.
- `cp`/`mv` with `-b` write the backup too, under `-S`'s suffix, or a name only known at run time without one.
- `recommended` asks about `~/.ssh` and `~/.config/git` themselves (a whole directory copied in), `~/.config`,
  `~/.bash_aliases`, `~/.bash_logout`, `~/.zlogin`, `~/.zlogout`, `~/.local/bin`, `~/.npmrc`, `~/.bunfig.toml` and
  cargo's user config.

### The user's configuration is matched by HOME as it started, by `~/bin`, and by Windows short names

- `~` globs also match from HOME as the script started (`Analysis.home`): `declare -a HOME`, which leaves HOME as it
  was but unknown to the analysis, no longer hides `~/.bashrc`.
- `recommended` asks about `~/bin`, which Ubuntu's `.profile` puts on PATH.
- A path with a Windows 8.3 short name (`BASHRC~1`, `SSH~1/…`) may be any file it shortens: path rules may match it.

### `recommended` in a project under HOME, an `outputs` rule field, and more destructive git forms

- A project under `HOME`, as most are, is judged as one anywhere else: `recommended` no longer names `~` among the
  places outside the working directory, since `..` from an absolute `cwd` covers it, and a path that can't be placed
  may be outside. `~/.bashrc` still asks.
- Rules take `outputs`: globs for the files an invocation's own arguments name (`sort -o`, `sed`'s `w`), without its
  redirections. `Invocation.outputs` holds them. `recommended` uses it for `sed`, `awk`, `uniq`, `xxd` and `tree`, so
  `sed -n 1,5p a > out.txt` runs.
- Deny and ask rules match `head` in any case as `HEAD`, and `GIT~1` as `.git`.
- `recommended` asks about `git checkout -B`, `switch -C`, `checkout -f`, `switch --discard-changes`, `checkout --ours`
  or `--theirs`, paths checked out from a commit, `restore` of the work tree, and `fetch --prune` into local branches or
  tags; it denies `git push --prune`.
- `GIT_TRACE2*` and other git variables with a digit are sensitive. `cp -s`, and copies that keep symlinks (`-P`, `-d`,
  `-a`, `-r` without `-L`), count their sources as written. `cargo fmt -- file` rewrites that file.

### Backquotes have their run-time aliases in POSIX mode

Bash parses backquotes as they run, like a process substitution, so in POSIX mode they get the aliases defined then,
even inside a `$(…)` that has its line's: `{ alias ls="rm -rf /"; x=$(echo \`ls\`); }`on separate lines runs`rm`.

### POSIX mode is followed as Bash follows it

`set` applies its options one at a time, as Bash does: `set -o[ posix` turns POSIX mode on before it fails at `[`.
Entering POSIX mode turns `expand_aliases` on and leaving turns it off, but `set -o posix` when it's already on
changes nothing; assigning `POSIXLY_CORRECT` always enters it, and unsetting it always leaves. In POSIX mode a
substitution Bash only parses as it runs, in a here-document or in text it expands again, gets no aliases.

### A process substitution's aliases in POSIX mode, at parse time and at run time

In POSIX mode Bash expands a process substitution's aliases as its line is parsed, then again as it runs, so either
may be what runs: `alias ls="rm -rf /"; { alias ls=cat; cat <(ls); }` on separate lines runs `rm`.

### Substitutions' aliases in POSIX mode, inner quotes in a quoted default, and names running out of braces

In POSIX mode Bash runs a command substitution as it parsed it with the line around it, so with that line's aliases
and none it defines itself: `{ alias rm=true; x=$(rm -rf /); }` on separate lines runs `rm`. In
`"${u:-"$"("rm -rf /)"}"` Bash removes the inner quotes before expanding, and runs `rm`. And braces expand before any
expansion in the word, so `{$,}s` is `$s s`.

### An assignment of a process substitution replaces the variable's value

`x=ls; x=<(:); $x` kept `x` as `ls`; it's now only known at run time, as in Bash, where it's a `/dev/fd` path.

### The words after a package script are walked with it

npm, pnpm and bun append the words after a script's name to it, so `npm test -- --config /tmp/x.ts` runs
`vitest --config /tmp/x.ts`. They were dropped: the script was walked bare, and allowed. Now they're appended, quoted,
before it's walked (bun drops a `--` right after the name; pnpm keeps it). Where it isn't walked (no `fs`, a
workspace, a word only known at run time), they're `exec:arbitrary`.

### Project code is the project's where the script starts

`npm --prefix /tmp/x test`, `cd .. && npm test` and `git -C /tmp/x commit` ran another directory's scripts or hooks
as `exec:project`. Project code run anywhere but under where the script starts is `exec:file` now, and so is a file
given from elsewhere that a tool runs or finds configuration beside: `bun test /tmp/x.test.ts`, `bun build
../x/entry.ts` (its macros run), `eslint ../other` and `prettier ../other` (configuration beside the files),
`oxlint` and `oxfmt` likewise. `tsdown -W` and `bun --env-file` are `exec:file`. So is git with another repository
(`-C`, `--git-dir`, `--work-tree` elsewhere), whatever the command: its config may run code (`core.fsmonitor`). Where is
where it really is: under a symlink to elsewhere (`cd link`), one the script may have made, or a work tree git has
rewritten, project code is `exec:file`. A relative `-C`, `--prefix` or `--cwd` after another is a place only known at
run time (git and make take it from the one before).

### Package managers

- With no package.json where it runs, npm looks in the directories above: the `exec-config` finding for that never
  fired, so the script went unwalked and allowed.
- npm's `-C` takes a directory: `npm -C run test` runs `./run`'s test script.
- `npm pack <spec>` packs another package: a directory's is `exec:file`, and one from the registry or a git host
  `network` and `exec:arbitrary` (npm installs it and runs its `prepare`).
- `npm -g run x` runs the local script, and is walked.
- The scripts `npm pack` and `npm version` run (`prepack`, `prepare`, `postpack`, the version scripts) are walked, and
  so is the commit `npm version` makes, whose hooks run.
- A flag that turns something off counts only given bare: npm reads `--ignore-scripts=false` as false, and it was
  read as `--ignore-scripts`, skipping the scripts.
- pnpm's `with`, `ci` and `query` (which installs), and bun's `ci`, `r`, `uninstall`, `list`, `getcompletes` and
  `bun bun` are their own commands, run in place of a script of that name.

### Git rewrites aren't the project's

A file git rewrote in the work tree was walked as it was before, as a `project-file` finding, whatever was checked out:
`git fetch origin pull/1/head && git checkout FETCH_HEAD -- package.json && npm run x` walked the old scripts. `HEAD`,
the index and a stash are no better: an earlier command, or this one, may have committed, staged or stashed anything
(`git stash apply FETCH_HEAD`, `git mv -f a package.json`). After any rewrite, a read in the work tree is unknown.

### Fetching dependencies

`cargo build` and the commands like it, and bun running code or tests, fetch what they haven't got: `network:read`,
which `recommended` allows for them, unless `--offline` or `--frozen` (cargo) or `--no-install` (bun).

### Others

- A prompt string's `\\` is one backslash once decoded, which escapes what follows as it's expanded.
- git opens `core.hooksPath` and include paths as given, so a `..` after a symlink leads up from where the symlink
  does. They were resolved as text.
- With `resolveJsonModule`, tsc copies the JSON its sources import into its output, from wherever it is: every `.json`
  is unknown after it, a package.json included, so `tsc && npm test` asks with `fs` (`tsc --noEmit` writes nothing).
- A short option spelled with a capital (`-W`) in a cac or yargs tool was given a bogus long name (`--w`), so tsdown's
  `-W` wasn't read as `--workspace`.

### What only project code may have changed is a `project-file` finding, which `recommended` allows

With a filesystem, a test run or build before a git command (`cargo test; git status`, `bun test && git stash pop`)
made git's config and hooks unknown, so the command asked, though the project code that might have changed them was
allowed to run anything itself. When the only program that may have written files no one can name is project code
the analysis doesn't follow (`exec:project`), a read after it is now a `project-file` finding, which `recommended`
allows. What was there before is still walked, so a hook that denies still denies, and real paths are kept. A policy that asks about `exec:project` still asks about the code. Anything else that
may write anything (`python3 -c`, `./build.sh`, `npm install`) still makes later reads `unknown-file`.

### A program's redirection no longer makes every later read unknown

`cat a > out && git commit` asked with a filesystem: the redirection gave `cat` a write its spec didn't name, which
counted as a program writing files no one can name. A redirection's writes are named, and now count as only those.

### Git's discovery, config and husky as git and husky read them

- A `.git` file is all after `gitdir: ` (spaces included), and it and `commondir` lead where the kernel goes: a `..`
  after a symlink leads up from its target. A `.git` whose `objects` or `refs` is a file isn't taken, so the
  repositories above it are followed.
- Repository discovery also starts from where the working directory really is, as git's `getcwd` does.
- Git config is parsed as git parses it: a key after its section's header, `;` and `#` comments after a value, single
  quotes as text, backslash-newline continuations. One git would refuse is an `exec-config` finding. An include under
  `~` is read from `HOME`.
- A relative `core.hooksPath` in a repository whose config says it's bare runs from where git started: a finding.
- The submodules `.gitmodules` names are followed: their config and hooks.
- A hook husky 7 or 8 runs through its helper is read as `sh`, which the helper runs it with.
- A `package.json` that gives a key twice is a finding: bun takes the first, npm the last.

### Prompt strings' escapes are decoded as Bash decodes them

Bash decodes a prompt string's escapes before it expands it, so `PS4='$(echo a\nrm -rf /) '` runs `rm -rf /`: `\n` is
a newline in the substitution. The analysis decoded only octal escapes, and allowed it. It now decodes `\n`, `\r`,
`\a`, `\e`, `\[` and `\]` too, and an escape whose value is only known at run time (`\s`, `\u`, `\w`, `\$` and the
others) in a prompt string that expands anything is a `dynamic-script` finding.

### `tsc` writes the file it's given, whatever its name

`tsc --outFile package.json` and `--tsBuildInfoFile` write that file, but only files of the kinds tsc emits counted as
changed after it, so a later `npm run` read the old scripts. A file named for tsc to write, or one biome's or tsc's
`--init` creates, now counts as changed; the files and directories they're given to work in still stand for files of
their kinds only.

### `$'…'` in a default inside `"$(…)"`, and an empty variable named across a line continuation

In a command substitution inside double quotes, Bash decodes a `$'…'` in a `${…}` operand and expands what it holds, so
`"$(echo ${y:-$'\x24(rm -rf /)'})"` runs `rm`. And an empty variable whose name runs across a line continuation is no
word, where it was read as an empty one.

### `recommended` allows `break` and `continue`

A loop that used either asked, as no rule allowed them, though `exit` and `return` were allowed.

### `recommended` allows `sed` and `awk` scripts that only edit what they read, and more programs that only look

`sed -n '1,40p' file` and `awk '{print $1}' file` run. A sed script is read command by command: `e`, `w`, `r` and the `e` and `w` flags of `s` are found wherever sed reads them, and a script that isn't followed (text for `a`, `i` and `c`, a delimiter in a bracket expression, an option the spec doesn't know) is `exec:arbitrary`. An awk program with `system`, a pipe, `getline`, `@` or a `>` after a `print` is `exec:arbitrary` or a write. Either writing a file asks, in place included.

Also allowed: `uniq`, `expand`, `unexpand`, `date`, `nproc`, `uptime`, `free`, `df`, `ps`, `pgrep`, `printenv`, `cksum`, `b2sum`, `sha224sum` and `sha384sum`.

### `sed -f` and `awk -f` are `exec:file`

A script file runs commands of its own. `awk -f` was `exec:project`, which `recommended` doesn't ask about, and `sed -f` had no effect at all.

### `date` with a time to set is `privilege`

`date 010100002030` and `date --se=now` set the clock as `date -s` does.

### Text after a process substitution in a redirection belongs to its target

`cat <<< <(f)x -n y` reads from one word, `<(f)x`, where the parser ended the target at the substitution and made `x`
an argument.

### Writes to `/dev/stdin` and `/dev/fd/N`

Linux opens `/dev/stdin` and `/dev/fd/N` again as the file that descriptor is on, which may be one opened for reading:
`{ … >>/dev/stdin; } < .git/config` writes `.git/config`. A write redirection to either is to a file only known at
run time, and so is one to `/dev/stdout` or `/dev/stderr` in code that may open those for reading.

### `secrets:read`: reading the environment, credentials files and secret variables

A new effect, which `recommended` asks about, for what reads a likely secret:

- the environment as a whole: `printenv`, `env` with no command, `export` or `export -p`, `declare -p`, `set` alone,
  `ps e`;
- a file that holds credentials, read, sourced, redirected or matched by a glob: `.env` and its variants (but
  templates like `.env.example`), `.envrc`, SSH private keys, `*.pem`, `*.key`, `.netrc`, `.npmrc`,
  `~/.aws/credentials`, `~/.kube/config`, gcloud and Azure credentials, `*.tfstate`, `/proc/*/environ`, in any case;
- a variable named like one, expanded in a command's words, redirections or here-documents (`echo $GITHUB_TOKEN`,
  `curl -H "Authorization: $API_KEY"`), but not one only tested with `test`;
- what kubectl, helm and terraform print of their own (below).

### Specs for kubectl, helm and terraform

- kubectl and helm read the cluster and chart repositories their config names as `network:read`, change them as
  `network`, and run commands in containers as `exec:remote` (`kubectl exec`, `run`, `debug`, `cp`). A word they
  don't know runs a plugin (`exec:arbitrary`); so do an editor (`kubectl edit`), a post-renderer, a getter plugin's
  scheme and kustomize's plugins and helm. A kubeconfig of their own may run a credential plugin (`exec:file`), and a
  server, kubeconfig or chart URL of their own is `network`. A `--dry-run` only reads.
- Printing a Secret (`kubectl get secret -o yaml`, `config view --raw`, `create token`, `helm get values`, `helm env`)
  is `secrets:read`. Changing the user's kubeconfig or helm configuration (`kubectl config use-context`, `helm repo
  add`, `helm registry login`) writes it, in HOME unless an option names another.
- terraform: `-chdir`, `-version` and `-help` before the command, options with one dash or two. `init`, `validate`,
  `plan` and `fmt` run the project's providers as project code (`exec:project`) and only read; `apply`, `destroy`,
  `import`, `test` and state changes are `network`; `output -json`, `output NAME`, `show -json`, `state pull`,
  `state show` and `console` are `secrets:read`. `TF_CLI_ARGS`, `KUBECONFIG`, `HELM_*` and the like are sensitive
  variables.
- `recommended` allows what only reads, plans or renders, and asks about the rest.

### Cargo, rustc, bun and less variables are sensitive

`CARGO_*` (a runner, a rustc wrapper, `CARGO_HOME`'s config, a target directory), `RUSTC`, `RUSTC_WRAPPER`,
`RUSTC_WORKSPACE_WRAPPER`, `RUSTDOC`, `RUSTFLAGS`, `RUSTDOCFLAGS`, `RUSTUP_TOOLCHAIN`, `RUSTUP_HOME`, `BUN_OPTIONS`
(`--preload`), `LESS` (a `+!` command git's pager runs) and `LESSKEY*` make the programs they're given to run code or
write elsewhere, as their options do.

### `set` and `shopt` read their options as Bash does

`set -eo posix`, `set -o -o posix` and `shopt -so posix` turn POSIX mode on, and with it aliases, which was missed:
`ls` defined as `rm -rf /` after any of them was allowed. Options end at the first word that isn't one (`set x -o
posix` sets positional parameters), and a bad letter or option name anywhere, or `shopt` with both `-s` and `-u`,
changes nothing.

### Code `sh` runs, and `env -S`'s other separators

- Code other programs hand to `sh` (`watch '…'`, `git rebase -x`, `tsdown --on-success`) was read as Bash with
  aliases off. Where `sh` is dash, `&>` runs in the background, `((` opens two subshells and `$'…'` is no string, so
  `watch 'ls &>/dev/null rm -rf y'` was allowed. Such code, and hooks and package scripts that `sh` runs, is read as
  Bash in POSIX mode with aliases on, and Bash's own syntax in it is a finding.
- `env -S` also splits at `\v`, `\f` and `\r`, and expands no braces: a string with one is only known at run time.

### A shell option only known at run time may be `-c`

`bash $x 'rm -rf /'` runs `rm` when `$x` is `-c`: each of the shell's arguments is walked as code it may run, and one
only known at run time is a finding.

### Shell options that change what runs are followed

`lastpipe` keeps what a pipeline's last command assigns, `localvar_inherit` gives a local its outer value, `allexport`
exports variables and functions to the shells a script starts, and BASHOPTS or SHELLOPTS, exported, pass options on.
`set -P`, `cd -P` and `cdable_vars` leave the working directory unknown. A compatibility level, `set -k` and `set +B`
are `unknown-syntax` findings, and a shell's `+` options (`bash +B -c …`) no longer hide its code. An assignment before
a function or builtin is a variable while it runs, and `unset` in a function may show a caller's hidden value.

### A shell that runs its startup files is a finding

`bash -i` reads `~/.bashrc` unless given `--norc`, and a login shell (`-l`, `--login`) reads `/etc/profile` and
`~/.profile` unless given `--noprofile`: code the analysis doesn't see, so an `exec-config` finding.

### `local -`, `local -g`, elements, `declare -p` and `cd -P`

- `local -` puts POSIX mode, `expand_aliases` and the other `set` options back when the function returns, so
  aliases and special builtins after it are read as Bash reads them.
- `local -g` assigns the global, not a local.
- `unset 'x[0]'` unsets a plain variable, and an element assigned with `declare`, `local` or `export` (which refuses
  it) leaves the variable's value only known at run time; so do `declare -a`, `-A` and a quoted `(…)` value, which
  may be a list.
- `declare -p` and `-F` assign nothing, and make no local in a function.
- After `cd -P` (or under `set -P`), the working directory is where symlinks lead, read from the files, or unknown
  without them; the last of `-L` and `-P` counts.
- `read -E` (Bash 5.3) assigns its names.

### What children inherit, aliases Bash doesn't expand or names with braces, `local -`, and `cd`

- `export -n`, `declare +x` and `unset` take a variable's export away, and `env -i`, `-u` and `NAME=` change what the
  command they run, and a shell under it, gets.
- No alias is expanded after an assignment followed by a redirection (`x=1 >f rm`), and an alias is looked up by the
  word as written, braces and all (`{ls,.}`).
- Returning from a function with `local -` puts POSIX mode back as `set` does, turning aliases with it; an
  `expand_aliases` the function changed may be either after.
- A logical `cd` whose `..` path isn't there goes where the kernel reads it, up from where a symlink leads; and with a
  nameref on `PWD` or `OLDPWD`, `cd` may fail after it moved.
- `enable -p` and `-d` turn no builtin off.

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

### Shell state follows when Bash expands a tilde, what a function's return puts back, and an alias on a function's name

- An unquoted `~`, `~+` or `~-` in an assignment, `export`/`declare`/`local` and a `for` list is expanded as it's
  assigned, so `d=~+; cd elsewhere; echo x > $d/f` writes where the assignment ran.
- A function's return puts a local's variable back to what it was when `local` ran: `f() { d=/tmp; local d=.; }` leaves
  `d` at `/tmp`.
- `declare -g` with a value under a temporary assignment of the same name keeps the value after the command.
- An assignment-only command (`x=/tmp >$x/f`) redirects with the values it just assigned.
- With aliases on, the name of a `name()` definition is alias-expanded, as Bash does: `alias rm=zz; rm() { …; }` defines
  `zz`, and `\rm` is still the program.

### Loops, line continuations, FUNCNEST and an inherited CDPATH are followed as Bash runs them

- A `while` or `until` loop ends right after the clause that stops it, with what that clause changed.
- A backslash before a newline continues the line, so an alias defined or removed earlier on it isn't in effect yet;
  one ending a comment continues nothing.
- A loop in a function isn't taken as settled from another call with other values outside, which the return puts back.
- Assigning `FUNCNEST`, past which function calls fail and the rest of the line is dropped, is a finding.
- A `CDPATH` from the environment makes where `cd name` goes only known at run time, as one assigned in the script does.

### A shell's here-document or here-string is walked as code

`bash <<'EOF'`, `sh -s x <<< 'code'`: what the shell reads from its standard input is followed like `bash -c`. A body
only known at run time, or other input (a pipe, a file, the caller's), is a `dynamic-script` finding. `-s` reads the
script from standard input, not from its first argument, and a lone `-` ends the options: `sh - <<< 'code'` reads it
too.

### `shopt` reads its options as Bash does

A lone `-` ends them and is a name, so `shopt - -s expand_aliases` turns nothing on, and a word with a letter Bash
rejects (`-s-`) changes nothing. Both were read as `shopt -s expand_aliases`, which made the analysis expand aliases
Bash didn't.

### Bash's own variables, namerefs and `command_not_found_handle` are followed

`BASH_ALIASES` and `BASH_CMDS` change the alias and `hash` tables, and a nameref (`declare -n`) or a variable named only
at run time may assign any variable: each was allowed before. Variables Bash sets itself (`RANDOM`, `PWD`,
`PIPESTATUS`, `_`…) are unknown whatever was assigned. `${x:=v}`, `printf -vNAME`, `wait -p`, `compgen -V`,
`exec {fd}>`, `coproc` and `select` assign, `unset` may remove a function, and `unset PATH`, `local PATH` and
`EXECIGNORE` are `sensitive-variable` findings. `command_not_found_handle` is walked for each program, and `fc`,
`set -H` and `history -w` are followed as running or writing history.

### Specs checked against the programs' documentation

Each of these was allowed while the program did more:

- `watch -s` (`--shotsdir`) takes a directory, so the command is the words after it.
- yq writes a file per document with `--split-exp-file`, and runs programs with `--security-enable-system-operator`.
- jest writes `--cacheDirectory` and `--coverageDirectory`, and `--clearCache` deletes the cache directory.
- git runs `gpg.ssh.defaultKeyCommand`, `trailer.<key>.command` and `.cmd`, `core.alternateRefsCommand` and
  `gc.recentObjectsHook`.
- `git config --global` writes `~/.gitconfig`, `--system` `/etc/gitconfig` and `--worktree` `.git/config.worktree`.
- A merge strategy git doesn't have (`git merge -s evil`) is `git-merge-evil` from PATH, for merge, pull, rebase,
  cherry-pick and revert.
- `git help -w` opens a browser.
- Setting `RIPGREP_CONFIG_PATH` is a finding: the file may name a program rg runs.
- `sort -T` writes its temporary files in that directory.
- tree reads a cluster's letters one at a time, each taking the next word after it: `tree -Lo 2 x` writes `x`.

### Aborts, `stash export`, `git config edit`, `cp -T`, `cargo rustc --` and more options that load code

- `recommended` asks about `git merge`, `rebase`, `cherry-pick` and `revert` with `--abort` or `--skip`, which put the
  work tree back over a resolution and what's staged, and about `git stash export --to-ref`, which moves a ref.
- `git config edit` runs an editor on the file it names, as `-e` does.
- `cp -T` copies a directory onto its target, under names only known at run time.
- The words after `cargo rustc --` or `cargo rustdoc --` (a linker, an output file) run as `exec:arbitrary`.
- `bun --tsconfig-override` and `--jsx-import-source`, and `jest --env`, load code. `MANOPT` is sensitive.

### `switch -m`, git's gc and help keys, compilers, pnpm and bun variables, and programs that open a browser

- `recommended` asks about `git switch -m` and `--conflict`, which merge local changes into conflicts.
- Git config that makes maintenance expire reflogs or prune (`gc.reflogExpire`, `gc.pruneExpire`, `maintenance.*`),
  and that makes `git help` run a browser (`help.format`, `help.browser`, `help.htmlPath`, `man.viewer`), is a finding.
- `CC`, `CXX`, `CPP`, `AR`, `LD` and their flags (`CFLAGS`, `LDFLAGS`…), with target and host forms, are sensitive: build
  scripts run them. So are `pnpm_config_*`, `BUN_INSPECT` and `BIOME_LOG_PATH`.
- `cargo help <word>` may run `cargo-<word>`; `cargo doc --open`, `vite --open` and `npm help` may run a browser.
- `biome --log-path` names where its daemon writes.

### More git config keys and build tools' deletes are caught

- `protocol.allow` (which lets an `ext::` remote run a command), `http.cookieFile` (which git writes cookies to),
  `mergetool.*.path`, `difftool.*.path` and `sendemail.smtpServer` are git config keys that change what git runs or
  writes: in a repository's config or given with `-c`.
- `vite build --outDir` (or `--emptyOutDir`) empties the directory first, and `tsdown -d` cleans its out-dir:
  both are `fs:delete`.

### Git's editor, more build tools' variables, and npm config in any case are caught

- Git forms that open the editor ask, as `git config -e` does: its default `vi` reads commands from the script's input
  (`printf ':!cmd' | git commit`). That's `commit` without a message, `tag -a`/`-s` without one, `rebase -i` and
  `--edit-todo`, `--edit` on commit, merge, tag, cherry-pick and revert, `--continue`, and `branch --edit-description`.
- npm reads `npm_config_*` from the environment in any case (`Npm_Config_Script_Shell`): all of them are sensitive.
- `PKG_CONFIG*`, `CMAKE*`, `PROTOC*`, `PYO3_*`, `LIBCLANG_PATH`, `CLANG_PATH`, `LLVM_CONFIG_PATH` and `BINDGEN_*`, which
  pick the programs cargo's build scripts run, are sensitive.
- jest's `--coverageReporters` are modules it loads; git's `branch.*.mergeOptions` and `pull.twohead`/`pull.octopus`
  may name a merge strategy, which runs `git-merge-<name>`.

### git and npm subcommands are named as themselves

`git revert` was `cherry-pick` and `npm unpublish` was `publish`, so rules naming them never matched; only real aliases (`npm i`, `git remote rm`) share a name now. `npm tst`, `npm rum` and `npm restart`'s stop and start scripts are followed, and `git ls-remote` reaches the network.

### An array literal's subscript is expanded twice

Bash expands `a=([$k]=1)`'s subscript, then expands what that leaves again, so `k='$(rm -rf /)'` runs `rm`: what a
known value leaves is walked, and one only known at run time is a `dynamic-script` finding, as it may be any code.

### `bash-gate/trace` runs a command under a supervisor that checks every exec against the analysis

`run(source, { mode })` runs the command in Bash with every `execve` in its process tree stopped by ptrace and seccomp. In `enforce` mode, one the shell or a wrapper it follows (`xargs`, `env`, `find -exec`) makes that the analysis didn't predict fails with EPERM before it runs; in `trace` mode it runs and is reported. x86_64 Linux, Node, and a C compiler to build the supervisor on first use. The coverage check is in the main entry too, as `covers` and `predicting`.

### Enforcement checks where a program is and the name it's started under

- `bash-gate/trace` held an exec to the program's file name only. Now the file must be where the invocation says (the
  path it was given, or a directory of the run's `PATH` for a name), so a `./ls` in the project isn't taken for `ls`,
  and the name it's started under (`argv[0]`) must be predicted too.
- `exec -a name` and `exec -l` start a program under another name, which some act on (`pgrep` as `pkill`, `git` as
  `git-branch`): the analysis gives it a `loads-code` finding.
- `find -exec … {} +` passes as many paths as fit, so its last `{}` may be several words: such runs are no longer
  refused.

### The shell a wrapper starts, relative paths under enforcement, `SHELL`, and `unshare` or `chroot` with no command

- `bash-gate/trace` covers the shell a wrapper runs code through (`flock -c`, `watch`, `dash -c`) only when it's the
  system's: `SHELL=./bash flock -c …` and a `PATH` set in that code no longer run another file named `bash`.
- A relative path is covered by the file it reaches from where the process really is, so `cd link && ../tool` through
  a symlink isn't taken for the `../tool` predicted.
- `SHELL` is sensitive: `flock -c`, `script -c`, `unshare` and `chroot` run it.
- `unshare` and `chroot` with no command run a shell on their input or a terminal: `exec:arbitrary`.

### The trace layer reads relative paths where they're run, and keeps paths meaning what they mean

- The supervisor reads a relative exec path from the process's own working directory, so `cd d && ./s` is `d/s`, and
  is judged against what the analysis predicted there.
- The run's Bash is the system's, not one an empty or relative `PATH` entry finds first.
- A new user or mount namespace, `chroot`, `mount`, `pivot_root`, `setns` and the new mount API fail with EPERM: no
  process in the tree changes what a path names or gains capabilities over the others (`unshare -r`).
- A shell a wrapper starts is covered only when it runs the code the wrapper was given; arguments that aren't UTF-8 only
  by a finding that hides code.
- `source` of a file the analysis doesn't see, and `mapfile -C`'s callback, leave the working directory unknown.

### A path through a symlink's `..` or `/proc` is never the system program or the file predicted

- `/proc/self/cwd/../../usr/bin/ls` or `link/../../usr/bin/ls` folds to `/usr/bin/ls` as text, while the kernel leaves
  from where the symlink leads: such a program path is no system path (`exec:file`), and under the supervisor no exec
  by it is covered, nor is a wrapper's shell started by it.

### Trap actions and prompt strings are walked between every two commands

Once set, they're walked at each point they may run, with the state there, and what they change carries on: `f() { :; }; trap f ERR; f() { rm -rf /; }; false; f() { :; }` and `x=ls; trap 'x=rm' DEBUG; $x -rf /` no longer hide `rm`. `trap -- 'action' SIG` is walked, and `trap - SIG` resets it.

### unbash 6.0.2

`$'…'` stops at its first NUL escape, as in Bash, and `<<` inside `${…}` no longer starts a here-document.

### unbash 6.0.3

An empty `$''` and a here-string that is a process substitution (`cat <<< <(f)`) parse, so they're analysed rather
than asked about as parse errors.

### An alias whose text is only known at run time counts as unseen code

`covers` accounted for one program with one word in its place, but such an alias can run anything: arguments, other
commands, wrappers.

### Files a program may write without naming them are unknown to later reads

With `fs`, a git command that rewrites the work tree (`checkout`, `stash`, `reset`, `merge`…) makes everything in it but `.git` unknown, and a program without a spec, one running code the analysis doesn't follow (`make`, `npm install`, `python3 -c`), or one whose spec writes without saying where makes every later read unknown: `git checkout evil && npm test` no longer trusts the `package.json` read before the checkout.

### uutils' `env` reads every lone `-` as `-i`, and the next word's alias is expanded before an operator

- GNU's `env` reads a lone `-` as `-i` only right after its options; after an assignment it's the command. uutils'
  `env` (Ubuntu's since 25.10) reads every `-` among the assignments as `-i`, so `env -- X=1 - rm -rf /` runs `rm` there.
  Both readings are walked.
- After an alias ending in a blank, Bash checks the first word of the next word's alias text for an alias too. The
  analysis skipped this when an operator followed that first word: `alias l='r&& x'` after `sudo ` ran `r`'s text
  unseen.

### An `env -S` string uutils reads differently leaves the command unknown

uutils' env splits only `-S`, `-vS`, `-vvS` and `--split-string` as spelled, before the first word that isn't an option,
and never again in what it split. Any other `-S`, such as `--split cat` or `-iScat`, it ignores, so the command
depends on which env runs it.

### ANSI-C `\x{…}`, signed and zero-padded brace sequences, `~+` after `PWD`, env's escapes, words that split into options, and exported temporary variables

Each of these was allowed while Bash did something else:

- `$'\x{2d}exec'` is `-exec`: Bash reads `\x{…}` as one byte from any number of hex digits, and the parser kept it as
  text.
- `-e{x..x..+1}ec` is `-exec`: a brace sequence's ends and step may have a `+` sign. Ends written with a leading zero
  pad every value (`{01..03}` is `01 02 03`), and a sequence too long to list is only known at run time.
- `~+` is `$PWD`, not the working directory, so setting `PWD` is a finding, as `HOME` is.
- `env -S` splits with escapes of its own (`\_` separates words), so a string with a backslash is only known at run
  time.
- A word that may split may hold options after its first field, whatever that starts with:
  `git log HEAD$(printf ' --output=f')`, and `find -name a$x` or `find -exec echo $x` with `x=' ; -delete'`.
- `a=rm export a` (and `declare -x`, `declare -r`, `readonly`) keeps `a` after the command. Exported from code `eval`
  or a function runs, the value is only known at run time: Bash 5.2 and 5.3 differ.

### `$'\U…'` past Unicode, and variables Bash sets as it starts, are read as Bash reads them

- A `\U` escape from 0x80000000 is dropped, as Bash drops it (`$'\UFFFFFFFF'rm` is `rm`); one from 0x110000 makes the
  word only known at run time, as Bash writes bytes of its own for it. The parser kept the escape's text.
- `IFS`, `SHLVL`, `BASH`, `BASH_VERSION`, `OPTERR`, `PS2`, `PS4` and the other variables Bash sets as it starts are
  only known at run time, whatever `environment.env` gives: Bash ignores an imported `IFS` and counts `SHLVL` up.

### What a wrapper starts is found on `PATH`, not in the shell's `hash -p` table

`hash -p /bin/true rm; env rm -rf /` was read as `env true -rf /`; `env`, `sudo`, `xargs` and the other wrappers now
run `rm`, as they do in Bash. The shell's own lookups, `command` and `exec` still use the table.

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

### `xargs --process-slot-var`, `nohup.out`, `script`'s log, and variables that load code or write

- `xargs --process-slot-var=NAME` puts `NAME` in what it runs' environment: `PATH` there is sensitive, and a name only
  known at run time is `exec:arbitrary`.
- `nohup` writes `nohup.out` where it runs, and `script` without a file writes `typescript`.
- `GCONV_PATH` (glibc loads code from it), `GNUPGHOME` (its `gpg.conf` names programs), and `SSLKEYLOGFILE` and
  `GNUTLS_KEYLOGFILE` (TLS writes its secrets there) are sensitive.

### Namerefs, compgen and file follow the code and writes they reach

- `declare -n r='a[$(cmd)]'` (and `local -n`) walks the target's subscript, which every read of `r` runs; a target only
  known at run time is a finding.
- `compgen -W` expands its word list, substitutions and all, and `compgen -F f` calls `f` in the shell itself.
- `file` with an argument only known at run time (`xargs file`, `file $a`) may be `-C`, which writes compiled magic in
  the working directory.

### History files, dash's missing builtins and `find --` are followed

- Assigning `HISTFILE` or `HISTFILESIZE` is a finding: Bash truncates the history file as `HISTFILESIZE` is set, and
  `set -o history` appends the script's own lines to it on exit (`HISTFILE=~/.bashrc`).
- Code handed to `sh` (`watch`, `git rebase -x`, hooks, package scripts) that calls a builtin dash doesn't have
  (`declare`, `shopt`, `source`, `let`, …) is a finding: dash reports it not found and runs on without it.
- `find --` ends find's leading options: the starting points follow it (`find -- / -delete`).

### `yq -i` and `file -C` write files

`yq -i '.a = 1' ~/.bashrc` was allowed as a read. `yq -i` writes the files it's given, `yq -s` and `file -C` write files named as they run.

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
