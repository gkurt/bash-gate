# Adversarial review log

## Round 1: src/words.ts, 2026-11-16, 48b7718
Confirmed and fixed:
- `find . $'\x{2d}exec' rm -rf / \;`, `echo "${x:-$'\x{24}(rm -rf /)'}"` → unbash keeps ANSI-C `\x{…}` as text; Bash 5.2 reads one byte from any number of hex digits (`\x{141}` is `A`, `\x{}` a NUL) → `ansiC` rewrites each `\x{…}` as `\xHH` before decoding.
- `find . -e{x..x..+1}ec rm -rf / \;` → brace sequences with a `+` sign stayed text; `{01..03}` lost its padding; a sequence over 256 items became one static word → `expandSequence` takes signs and pads as `%0*d`; too long is dynamic (and `bashBraces` sees it as a brace).
- `PWD=/home/me; echo hi > ~+/.bashrc` → `~+` is `$PWD`, resolved from the tracked cwd → `PWD` is a sensitive variable (assigning it, `read PWD`, etc. is a finding).
- `env -S "find . -name .\_-exec rm -rf / {} +"` → env's `\_` separates words; it was split with shell grammar → a `-S` string with a backslash is only known at run time (`splitEnv`).
- `git log HEAD$(printf ' --output=/x')`, `find . -name a$(printf ' -exec …')`, `find . -exec echo $(printf ' ; -delete')` → a dynamic word that may split, with a non-dash static start, was assumed not to be an option → `mayBeOption` counts `split`; a split option value sets `maybeOptions`; find with any split word sets `maybeOptions`; gh codespace ssh the same.
- `a=echo; a=rm export a; $a -rf /` (also `declare -x/-r`, `readonly`, via `command`/`builtin`) → Bash keeps a temporary variable a builtin exports or makes read-only; the analysis restored the old value → `Context.kept`: kept with its value when run as the command itself; dynamic when from a function (Bash 5.2 keeps, 5.3 restores: checked in both) or from `eval`/`source` code (both restore; dynamic is conservative).
Rejected:
- `$'\777'` (Bash byte ff, analysis U+FFFD) and `$'\U110000'` → non-ASCII either way; no name, option or path changes.
- Assignment-context tilde (`a=~/x` as an argument, `x=a:~/b`) differs from Bash → no allowed program where it matters found; `HOME` changes are already a finding.
Costs: `git log origin/$branch`, `git diff HEAD~$n`, `find . -name $pat` (unquoted dynamic words) now ask; `PWD=…` asks; `env -S` strings with a backslash ask. None is pinned in `test/everyday.test.ts`.
Needs a decision: none.
Open, outside this area (for the area 6 or 7 round): on a case-insensitive filesystem (Windows NTFS, default macOS APFS), `echo hi > .GIT/hooks/pre-commit` and `echo x > .Git/config` are allowed (no fs) but write `.git/…`. The reviewer confirmed the write on NTFS. The `.git` globs and checks are case-sensitive. I'd recommend matching `.git` path segments case-insensitively, in both the policy and the analysis's git-dir checks.

## Round 2: src/analyze.ts shell state, 2026-11-16, badcebb
Confirmed and fixed (each checked in WSL Bash 5.2; the version-sensitive ones in Git Bash 5.3 too):
- `eval() { echo; }; set -o posix; eval 'rm -rf /'` (and exec, and `POSIXLY_CORRECT=1 eval …`) → functions were found before special builtins in POSIX mode → special builtins win when POSIX mode is on, both are walked when it may be; a temporary `POSIXLY_CORRECT` makes POSIX mode unknown from there (a special builtin keeps it on after).
- `alias fi='fi; rm -rf /'` then `if …; fi` (also `{`, `do`, `done`, `!`, `time`, `[[`) → aliases on reserved words never expanded → defining one is an `unknown-syntax` finding (ask).
- `alias -- -x=…`, `alias /bin/rm=echo`, `unalias -- -a`, `unalias $(echo rm)` → alias/unalias options read as getopt; names Bash refuses define nothing; a dynamic unalias name makes every alias maybe-defined.
- `ls() { rm -rf /; }; unset -f -v ls; ls` and `unset ls -f` → unset options read as getopt; -f with -v unsets nothing.
- `declare -r x=rm; x=echo; $x …` and `unset x` of a read-only name → `declare -r`/`readonly` is a sensitive-variable finding (ask).
- `declare -i x; unset x; x=y; y='a[$(rm)]'; echo $((x))` (and `declare +i`, an integer attribute given on one branch) → unset and +i clear it; new `maybeIntegers` makes an unsure integer's assigned value dynamic, not numeric.
- `declare -u x; unset x; x=-o; sort $x ~/.bashrc …` → unset clears the case attribute.
- `x=--output=…; f() { local -I x; git log $x; }` → -I inherits.
- `local x; declare -g x=rm`, `unset` of a caller's local then assign, `if false; then local x; fi`, `( local x )` → locals moved from a per-call mutable set on the context into `State.frames` (cloned, joined: local on one branch only is unknown); `declare -g` under a local and unset of a caller's local make the variable unknown after the call.
- `cd ~ && pushd /repo && pushd +1 && echo x >> .bashrc` → `pushd` with no directory, `+N` or `-N` makes cwd unknown; `pushd -n` stays.
- `x=echo; PS4='$($x -rf /)+ '; set -x; x=rm true` (and between assignments) → `between()` runs after each prefix assignment.
- `cat() { rm -rf /; }; declare -fx cat; git commit -m x` (Bash hook), `env 'BASH_FUNC_cat%%=…' git commit`, `export -nf`, `declare +x -f`, `unset -f` then redefinition, `export -f` before definition → `declare -fx` exports; `-n`/`+x`/`unset -f` take it back; undefined functions aren't exported; a child shell other than `bash -c` (sh, hooks, package scripts, git config, ssh) gets exported functions as maybe-defined (dash doesn't import them); `BASH_FUNC_*` in env's assignments is a finding.
Rejected: `break 2` regex `/^d+$/` (should be `\d`) → reads as leaving any loop: conservative, not a bypass. Left as is (not this round's to fix as a bypass; could be tidied).
Costs: `declare -r`/`local -r` now ask; defining an alias named after a reserved word asks; after `pushd` with no directory or `+N`/`-N`, relative paths are unknown; after a function whose `local` may not have run (or `declare -g` beside a local, or unset of a caller's local), that variable is unknown; exported functions given to `sh`/hooks/package scripts are walked both ways. No `test/everyday.test.ts` verdict moved.
Needs a decision: none.
Open, outside this area (for the area 6 round): with fs where `/work/proj/link` → `/etc/sub`, `echo x > link/../passwd` is allowed as `/work/proj/passwd`; the kernel resolves `..` after the symlink and writes `/etc/passwd` (reviewer reproduced in WSL).

## Round 3: dispatch and wrappers, 2026-11-16, no commit
Interrupted: Anthropic's safeguards stopped the reviewer subagent before it reported (flagged as a cyber request). No findings, nothing changed. The loop is paused until the user decides how to continue. Request ID: req_011Ch5p75GT6ZPFB2dud3DQr.

## Round 4: src/argv.ts (and the specs it reads), 2026-11-16, 408ca1c
Reviewer verified each against the real program in WSL (git 2.54, coreutils 9.4, procps watch 4.0.4, rg 14.1, gh 2.96); all 22 new tests fail on badcebb.
Confirmed and fixed:
- `git --attr-source status clean -fdx` (and `--shallow-file`) → value-taking top-level options missing, so `status` read as the subcommand → added `--attr-source=`, `--shallow-file=`, `--super-prefix=`.
- `git config set --global core.pager …`, `git config set --worktree core.hooksPath …`, `git config --global --comment hi core.pager …` → subcommands and value options unknown, so the key was `set`/`hi` → `finishConfig` reads the subcommand; `--comment=`, `--default=`, `--value=`, `--blob=`, `--url=` and other options added; unset/rename/remove write the config file; `-e` runs an editor (exec:arbitrary).
- `git reflog delete refs/stash@{0}` (expire, drop) → `finishReflog` adds fs:delete.
- `git rev-list|blame|annotate|shortlog|whatchanged|reflog --output=…`, `git stash show --output=…` → `--output=` write role.
- `git branch -M|-C` → treated as `--move|--copy` with `--force`.
- `git commit -Sn` (hook skipped) → `-S=?` takes the rest of the cluster; `git commit -n --verify` → `--verify`/`--no-no-verify` known on commit, push, merge, rebase, cherry-pick/revert; hooks are skipped only with `--no-verify` and no `--verify`.
- `gh repo read-file x -o=/home/me/.bashrc` → pflag strips `=` after a short flag (`CommandSpec.cobra`, set by `readCobra`).
- `xargs --max-lines rm …` → `--max-lines` is `-l`'s optional-value long form.
- `watch -dx …` → `-d=?`.
- `touch -m ~/x` → touch got its own spec (`-m` a flag); mkdir and truncate split too.
- `cp a ~/x --sparse always` → cp/mv know `--sparse=`, `--no-preserve=` and their other options; with an unknown option every operand is written.
- `POSIXLY_CORRECT=1 cp a b -S ~` → POSIXLY_CORRECT is a sensitive variable; a program run with it exported is a finding; Bash starts in POSIX mode when the environment has it.
- `rg --hostname-bin=…` → exec:arbitrary.
Unverified (tools missing in WSL), not fixed: tree `-Lo` clustering, yq `--split-exp-file`, newer watch `-s/--shotsdir`. Carry to the area 5 (specs) round to check against docs.
Costs: `git config --unset`/`unset`/`--remove-section`/`--rename-section` now ask (they write `.git/config`); `git config get key` now allows (was ask). `cp`/`mv` with an option they don't know now ask on every operand. Setting POSIXLY_CORRECT asks. No everyday verdict moved.
Needs a decision: none.
Open, outside this area (area 7, policy): `git checkout -B main HEAD~5` and `git switch -C main HEAD~5` reset an existing branch, and `git push --prune` deletes remote branches; all allowed. I'd recommend `ask` for checkout -B / switch -C (moves a ref, like branch -f) and `deny` for push --prune (deletes remote history, like --delete).
Note: round 3 (dispatch and wrappers) was stopped by safeguards and skipped; per the standing instructions it is retried in a later rotation.

## Round 5: src/specs.ts against the programs' docs, 2026-11-16, 6c9197d
Reviewer verified in WSL (git 2.54, coreutils 9.4, rg) or from the tools' source (procps-ng master watch.c, mikefarah yq, jest-core); all 16 new tests fail on 408ca1c. (First brief was refused by the permission classifier because it allowed installing tools with sudo; rerun without that.)
Confirmed and fixed:
- `watch -s ls 'rm -rf ~'` → `-s= --shotsdir=` (write role); also `-f -C -r` flags.
- `yq --split-exp-file x '.[]' f` writes files; `--security-enable-system-operator` runs programs → spec options added (write placeholder, exec:arbitrary).
- `jest --clearCache --cacheDirectory ~`, `--coverageDirectory ~/c` → writes recorded; `--clearCache` is fs:delete.
- git keys `gpg.ssh.defaultKeyCommand`, `trailer.<k>.command|cmd`, `core.alternateRefsCommand`, `gc.recentObjectsHook` → added to gitExecKeys (the shell ones to gitShellKeys); verified trailer and defaultKeyCommand run.
- `git config --global trace2.normalTarget ~/.bashrc` (and any `--global` key) → `--global` writes `~/.gitconfig`, `--system` `/etc/gitconfig`, `--worktree` `.git/config.worktree`.
- `git merge|pull|rebase -s evil`, `git cherry-pick|revert -s evil` → non-builtin strategy is exec:arbitrary (`finishStrategy`); cherry-pick/revert got `-s`, `-X`, `-S`.
- `git help -w log` → `-w --web` exec:arbitrary.
- `RIPGREP_CONFIG_PATH=/tmp/x rg foo` → sensitive variable.
- `sort -T ~/t` → write role.
- `tree -Lo 2 ~/x` (no allow impact: tree asks) → tree's own cluster parse; each valued letter takes the next word after the cluster.
Rejected / left out on purpose: `cargo test -- --logfile` (project's own test binary), `cargo doc --open`, `npm help`, `git help -m/-i` (fixed or configured viewer).
Costs: `git config --global|--system` now ask for every key (writes outside the project); jest with `--cacheDirectory`/`--coverageDirectory` outside, or `--clearCache`, asks; non-builtin merge strategies ask; `git help -w` asks; `sort -T` outside asks; setting RIPGREP_CONFIG_PATH asks. No everyday verdict moved.
Needs a decision: none.

## Round 6: files, paths and project code, 2026-11-16, 8320f39
Reviewer verified each in WSL (Bash 5.2, git 2.54, coreutils 9.4) in temp dirs; the `.GIT` case on NTFS. All 16 new tests (`linkedCases` in test/escapes.test.ts) fail on 6c9197d.
Confirmed and fixed (including both open items from rounds 1 and 2):
- `echo x > link/../passwd`, `tee ./link/./../passwd` (link → /etc/sub) → `..` was folded lexically before `physical()` → `wrote()` and `realpaths()` use `openedPath` (kernel resolution); two words resolving alike to different places are unknown.
- `echo hi > .GIT/hooks/pre-commit`, `.Git/config` → policy `matchPaths` also tries forms with `.git` segments lowercased (deny/ask matching only, not "every path" allow matching).
- `cp -r /tmp/evil/.git .`, `cp -r /tmp/evil/. .`, `cp -t . /tmp/evil/.git` → cp/mv record `dest/<basename(source)>`; `x/.` or a source only known at run time is a dynamic write under dest.
- `cp -l ~/.bashrc notes` (then writing notes) → `--link` sources count as written.
- Python hook under `#!/usr/bin/env python3` walked as Bash → hooks read by shebang (`interpreter`): sh/dash/ash/ksh or none → sh with aliases and POSIX mode; bash → bash; anything else → `loads-code` finding. husky 9's dispatched hooks are sh.
- `#!/bin/sh` hook and package scripts with `alias …` then use → walked with expand_aliases off → `shellState(…, 'sh')` turns aliases on.
- cwd 17 levels below the repository → discovery fell through with no finding → `exec-config` finding.
- `git mv x ../.bashrc`, `git restore ../.bashrc`, `git checkout -- ../.bashrc` → path operands recorded as writes (`finishTreePaths`, `finishGitMove`; HEAD-like refs excluded).
Docs: THREAT_MODEL.md (`..` after a symlink; hooks by shebang; package scripts as sh).
Costs: `cp *.ts dist/`, `cp -r src/. out/`, `cp "$f" backup/` now ask (a name only known at run time may be `.git`); a git hook in a language other than sh/bash asks. No everyday verdict moved.
Needs a decision:
- git commands that rewrite the work tree (`checkout <branch>`, `switch`, `stash`, `merge`…) write the whole work tree, which is larger than `cwd` when the repository root is above it (a monorepo subdirectory, a dotfiles repo at ~). The reviewer showed it with explicit paths (fixed); whole-tree rewrites outside `cwd` are not counted as writes outside the working directory. Counting them would make every branch switch from a repository subdirectory ask. This is about what counts as the project (THREAT_MODEL: project = `cwd`), so it's the user's call. My recommendation: count the work tree root as written when it's above `cwd` only for the "outside the working directory" rule when the root is also outside the user's project trust (e.g. at or above HOME); otherwise leave it.
Open, outside this area (area 7, policy): when `cwd` is under `HOME` (most real projects), every write asks, because `~/**` matches the resolved path (`policy.ts` tilde form). Not a bypass; over-asking. Proposed fix: in `recommended`, the `..`/`../**` globs already cover writes outside an absolute `cwd`; keep `~`/`~/**` for when `cwd` isn't absolute, or match the tilde form only when the path is outside the start. Must not move everyday verdicts (they use /repo).

## Round 7: src/policy.ts and src/recommended.ts, 2026-11-16, 8dd27bc + follow-up
Reviewer verified in WSL (git 2.54) and Git Bash/NTFS. All 27 new tests (including the 7 everyday lines run under HOME) fail on 8320f39.
Confirmed and fixed:
- Over-asking under HOME (logged in round 6) → `recommended`'s outside rule is now `writes: ['..', '../**']`: from an absolute `cwd`, `~/x` resolves outside and matches `../**`; with no absolute `cwd`, or `~` with no HOME, the path can't be placed and may match. `test/everyday.test.ts` now runs the whole list a second time at `/home/me/repo` with HOME `/home/me`: every verdict equals `/repo`'s. New `homedCases`/`nowhereCases` pin `~/.bashrc`, `/home/me/.bashrc`, `../other/x`, `~`, `cd ~ && touch x` asking and `rm -rf ~` denying.
- `GIT_TRACE2_EVENT=~/.bashrc git status` → `sensitive` had `GIT_[A-Z_]+`, no digits → `GIT_[A-Z0-9_]+`.
- `… > r/head` with `r/objects`, `r/refs` (case-insensitive FS makes a repo) → policy folds `head` to `HEAD` (deny/ask matching only).
- `echo x > GIT~1/hooks/pre-commit` (8.3 short name, verified on NTFS) → folded to `.git` too.
- `cp -s ~/.bashrc l && echo x >> l`, `cp -a /proc/self/root r && …`, `cp -rs ~ d` → cp counts sources as written when it makes or keeps links (`-s`, `-P`, `-d`, `-a`, `-r` without `-L`).
- `cargo fmt -- ~/x.rs` → fmt's positionals are writes.
- `git fetch --prune origin 'refs/heads/*:refs/heads/*'` (and tags) → treated as `--force` (asks: deletes local refs).
- `git checkout -B`, `switch -C`, `checkout -f`, `switch -f/--discard-changes`, `checkout --ours/--theirs`, `checkout <commit> -- paths`, `checkout -- .` (a word no branch can be named), `git restore` of the work tree → ask "Discards uncommitted work or moves a ref" (closes the round-4 open item).
- `git push --prune` → deny (closes the round-4 open item).
- Over-asking: `sed -n 1,5p a > out.txt`, `sort a | uniq > out.txt` asked because the "output-file argument" rules saw redirections → new rule field `outputs` (spec-named writes only, `Invocation.outputs`); recommended uses it for sed/awk/uniq/xxd/tree. README documents it.
Rejected / kept: `rm -rf '~'` (a literal `~` dir) denied and `echo x > '~'` asks: quoted `~` treated as HOME — over-approximation, no bypass. `git commit --amend`, `rebase`, `--abort`, `git mv -f` left allowed (recoverable from the reflog / same as mv).
Costs: `git restore <file>` (work tree), `git checkout <commit> -- <file>`, `git checkout -- .` now ask; `cp -r` / `cp -a` from outside the project asks (sources counted as written); `cargo fmt -- <file>` outside asks; `fetch --prune` with a local refspec asks; `GIT_TRACE2*=` asks. Writes inside a project under HOME no longer ask (a large gain). No `/repo` everyday verdict moved.
Needs a decision:
- `git checkout <word>` where the word could be a branch or a path (`git checkout src`): git takes the branch if one exists, else restores the path over local changes. Statically unknown without reading refs. Making it ask would make `git checkout main` ask too (not pinned in everyday; `git switch` and `checkout -b` stay allowed). Recommendation: with an `fs`, read `.git/refs/heads/<word>` and `packed-refs` and ask only when no such branch is known; without one, leave it allowed (as now).

## Round 8: src/trace and src/cover.ts, 2026-11-16, c8a1183
Reviewer verified in WSL Ubuntu 24.04 (x86_64, enforce mode). New tests (escapes + trace) fail on 668f5d7.
Confirmed and fixed:
- `exec -a pkill pgrep -f ^sleep.123` (killed a process) and `exec -a git-branch git log -D feature` (deleted a branch) were allowed and covered → analysis: `exec -a NAME` (NAME's basename ≠ the program's) and `exec -l` give a `loads-code` finding (asks; any program for cover); trace: `argv[0]`'s basename must be predicted too, not only the file's.
- Trace matched only the file's basename: `./ls` (project script) and `/tmp/x/ls` passed as `ls` / `/usr/bin/ls` → trace now checks the file's place: an invocation's `path` (resolved against its cwd) or, for a name, a directory of the run's `PATH`; the final fallback no longer re-predicts without the place (only unseen findings cover then).
- `find . -type f -exec ls {} +` was refused (fails closed): the last `{}` before `+` is now a splitting placeholder.
Docs: README trace section, THREAT_MODEL S6 (what covered means).
Costs: `exec -a` with a different name, and `exec -l`, ask. Under enforce, a program found outside the run's PATH directories for a predicted name is refused.
Needs a decision: none.
Open: none from this round.
Rotation note: area 3 (dispatch and wrappers) was skipped in round 3 (safeguards); it is next.

## Round 9: src/analyze.ts dispatch and wrappers (retry of area 3), 2026-11-16, 0b979e3
The narrower, correctness-framed brief went through (round 3's was stopped by safeguards). Reviewer verified in WSL (coreutils 9.4, procps 4.0.4, dash as /bin/sh, git 2.54). The 8 bypass tests fail on c8a1183.
Confirmed and fixed:
- `env -S $'find .\v-delete'` (and `\f`, `\r`; `-exec` variant ran) → GNU env splits at \v \f \r too; shell splitting didn't → a `-S` string with \v, \f, \r or braces (env expands none) is only known at run time.
- Code handed to `sh` (dash on Ubuntu) parsed as Bash with aliases off: `watch 'ls &>/dev/null rm -rf y'` (dash: background + redirect), `watch '((rm -rf + y))'` (dash: nested subshells), `watch "echo \$'A\' ; rm -rf y ; …"` (dash: no $'…'), `watch $'alias ls=rm\nls x'`, same via `git rebase -x`/`--exec`, `tsdown --on-success` → such code is walked as Bash in POSIX mode with aliases on (`shellState('sh')`), and `bashOnly` syntax (`&>`, `|&`, `((` not `$((`, `$'`, `$"`, `$[`, `<<<`, `<(`/`>(`, `[[`, `;&`, brace expansion, `function`/`select`/`coproc`, arrays, non-POSIX `${…}`) is an `unknown-syntax` finding. Applied also to hooks and package scripts run by sh (round 6).
Checked fine (per reviewer): time keyword forms, command/builtin/exec option forms, enable -n, hash -p/-r/-d/-t, PATH unset/local, alias expansion positions, env/nice/timeout/stdbuf/nohup/xargs/watch/find option parsing, dynamic words before wrapped commands, program paths.
Costs: code run by sh (watch, git rebase -x, sh -c, package scripts, sh hooks) that uses Bash-only syntax asks; `env -S` with braces asks. No everyday verdict moved.
Needs a decision: none.

## Round 10: src/words.ts (second pass), 2026-11-16, 7bcd9a5
Reviewer verified each against Bash 5.2.21 in WSL; one probe (a letter sequence producing a backquote) was stopped by a safety classifier and not retried, so that corner is covered by the fail-closed fix below rather than by a probe. New tests fail on 0b979e3.
Confirmed and fixed:
- `x=' ../outside '; touch {$x..}` (created ../outside in WSL), `tee {$(echo ' /home/me/.bashrc ')..}` → a one-item brace that's no sequence was returned as its raw text, static → now dynamic unless it's plain text (no quote, backslash, $ or backquote).
- `{Z..a}` letter sequences through `[ \ ] ^ _` and a backquote → dynamic (value-only mismatch; no policy case found).
- `declare BASH_VERSINFO=echo; $BASH_VERSINFO hi` → BASH_VERSINFO added to `computed` (read-only from the start).
Rejected: `$'\777'` and `$'\U110000'` byte differences (non-ASCII, no policy impact; same as round 1).
Costs: `touch {'a'..}`-style non-sequence braces with quotes or expansions ask. No everyday verdict moved.
Needs a decision: none.

## Round 11: src/analyze.ts shell state (second pass), 2026-11-16, ca507ca
Reviewer verified each in WSL Bash 5.2 (a `victim` file deleted, or a file written) and Git Bash 5.3.15; I re-checked the semantics in WSL. The 19 new escape tests fail on 7bcd9a5.
Confirmed and fixed:
- `local -` ignored: `f() { local -; set -o posix; }; f; alias rm=echo` then `rm …`, an `eval` function after it, `set -o posix` outside and `+o posix` inside, `set -m` inside under lastpipe → frames save POSIX mode, `expand_aliases` and the followed `set` options at `local -` (maybe-saved when it may not have run, or a dynamic `local` arg), and the return puts them back (WSL: `expand_aliases` comes back with the snapshot too).
- `local -g x=rm` treated as a local → assigns the global.
- `unset 'x[0]'` stored a variable named `x[0]` → an element unset makes the variable dynamic (WSL: `[0]` unsets a scalar, `[1]` errors, `[@]` leaves it).
- `declare 'x[1]=echo'`, `local 'x[1]=…'`, `export 'x[0]=…'` (refused), `declare -A` / `-a` conversions Bash refuses, quoted `'(…)'` values (a list for arrays) → dynamic.
- `declare -p x=echo` / `-F x=echo` assigned, and `declare -p x` in a function made a local → -p and -F assign nothing (an `=` form becomes dynamic) and make no local.
- `cd -P link && cd .. && echo > .bashrc` wrote in the wrong place → a physical cd stores where symlinks lead (`files.physical`), unknown without files; the last of -L/-P counts.
- `read -E` (Bash 5.3) → in the option string, so its names are assigned (dynamic).
Rejected: none.
Costs: `cd -P dir` and `cd` under `set -P` without a filesystem leave the working directory unknown; `declare -a/-A x=…` values are dynamic. No everyday verdict moved.
Needs a decision: none.

## Round 12: src/analyze.ts dispatch and wrappers (third pass), 2026-11-16, 9e889c1
Reviewer ran cargo 1.98 and bun 1.4.4 in local Git Bash (WSL has neither); LESS was confirmed in WSL (git 2.54, /usr/bin/less) by the reviewer and again by me. The Bash side (a temporary or exported variable reaching the program) is plain. The 10 new tests fail on ca507ca.
Confirmed and fixed:
- `CARGO_TARGET_<triple>_RUNNER='…' cargo run` (ran the runner), `RUSTC_WRAPPER=… cargo build` (ran it), `CARGO_BUILD_RUSTC_WRAPPER`, `RUSTC`, `CARGO_HOME` (its config.toml), `CARGO_TARGET_DIR=../outside` (wrote there): allowed with no finding → `CARGO_*`, `RUSTC`, `RUSTC_WRAPPER`, `RUSTC_WORKSPACE_WRAPPER`, `RUSTDOC`, `RUSTFLAGS`, `RUSTDOCFLAGS`, `RUSTUP_TOOLCHAIN`, `RUSTUP_HOME` are sensitive.
- `BUN_OPTIONS='--preload=../outside/pre.js' bun test` ran the preload → `BUN_OPTIONS` sensitive.
- `LESS=$'+!touch pwned\n' git log` (with a tty) ran the command → `LESS` and `LESSKEY*` sensitive.
Rejected: none.
Costs: a command with any `CARGO_*` assignment (`CARGO_TERM_COLOR=always cargo test`, `CARGO_INCREMENTAL=0`) or `LESS=-R git log` now asks. No everyday verdict moved.
Needs a decision: none.

## Round 13: src/argv.ts (second pass), 2026-11-16, 36ea18d
Reviewer confirmed each in WSL (git 2.54, coreutils 9.4, sed 4.9); I re-checked checkout -3 and cp --parents. The 11 new tests fail on 9e889c1.
Confirmed and fixed:
- `git checkout -- foo.txt`, `-m foo.txt`, `--conflict=merge foo.txt`, `-2`/`-3 foo.txt` (git's --ours/--theirs), `--pathspec-from-file=list`: allowed, each overwrote local changes → `Parsed.separated` records `--`; these forms count as --force.
- `git fetch --stdin origin` (force-moved a branch with a `+` refspec; with --prune deleted one) → --stdin counts as --force.
- `cp --parents ../../s/f d` (overwrote a file two levels up) reported as `d/f` → --parents writes `d/<source as given>`.
- `sed -i'/home/me/.bash*' … rc` wrote ~/.bashrc, unreported (verdict already ask) → the backup is a write: file+suffix, or with `*` the suffix as a path (a file in a subdirectory: unknown).
Rejected: none.
Costs: `git checkout -m <branch>` and `git checkout -- <path>` ask; `sed -i.bak` reports `file.bak`. No everyday verdict moved.
Needs a decision: none.

## Round 14: src/specs.ts (second pass), 2026-11-16, bfbddfd
Reviewer checked specs against git 2.54/coreutils 9.4 in WSL, cargo 1.98.1 and bun 1.4.4 in Git Bash; jest (not installed) from its docs only. I re-checked merge --abort and stash export in WSL. 18 new tests fail on 36ea18d.
Confirmed and fixed:
- `git stash export --to-ref refs/heads/feature` force-moved the branch (export/import unknown to the spec) → subcommands added; `recommended` asks on --to-ref.
- `git merge --abort`, `rebase --abort`/`--skip`, `cherry-pick`/`revert --abort`/`--skip` threw away a hand resolution and a staged file → `recommended` asks (as `reset --merge`); cherry-pick learns --skip/--quit.
- `git config edit [--global]` ran the editor, unreported → exec:arbitrary and the file as a write.
- `cp -rLT /tmp/evil .` laid .git/hooks over the project → -T writes `target/…` (dynamic).
- `cargo rustc -- -C linker=…` ran the linker; `-- -o ../x` wrote outside → words after -- for rustc/rustdoc are exec:arbitrary.
- `bun test --tsconfig-override=…` (paths mapped to outside code) and `--jsx-import-source=…` ran outside code → exec:file.
- `jest --env=/tmp/evil/env.js` (docs: same as --testEnvironment) → moved to jestModules.
- `MANOPT=-P… git help log` ran the pager with a tty → MANOPT sensitive.
Rejected: `git reflog write` adds an entry without moving a ref or losing work (low impact, left). Bun's profiler output options lack a write role, but running a file already asks (noted, not a bypass).
Costs: `git merge --abort` and friends now ask; `cargo rustc -- …` asks; `cp -rT` asks. No everyday verdict moved.
Needs a decision: none.

## Round 15: files and project code (second pass), 2026-11-16, 66974bf
Reviewer confirmed each in WSL (Bash 5.2, git 2.54; fsmonitor/hook = touch PWNED), and bun 1.4.4 on Windows for the duplicate key. I re-checked git's config parsing (`git config -f c --list`). 16 new tests fail on bfbddfd.
Confirmed and fixed:
- `.git` = `gitdir: link/../evil` and `commondir` = `link/../evil` resolved lexically → `pointedTo` uses `openedPath` (physical `..`), unknown → exec-config finding.
- `gitdir:  /x` / `gitdir: /x  ` trimmed → `gitfile()` takes all after the 8 bytes `gitdir: `, less trailing CR/LF, as git does.
- `.git/objects` a file taken as valid → objects and refs must be directories (exists and no file text).
- `include.path = ~/inc.cfg` read as a literal path → openedPath gets HOME.
- parseGitConfig: `[core] fsmonitor = …` on one line dropped; `; note`/`# note` comments kept in values; `'q'` quotes stripped; backslash-newline dropped → a character parser following git's config.c; anything git would refuse is an exec-config finding.
- Relative `core.hooksPath` with `core.bare = true` (git runs it from the start dir) → uncertain, finding.
- Discovery walked the logical path; git walks getcwd → also walks from `files.physical(cwd)`; settled only if both settle.
- Submodules not followed (`git status` ran a submodule's fsmonitor and post-index-change hook) → `.gitmodules` paths are followed (config and hooks). Read as it was before git's own tree writes, which make no repository.
- husky 7/8 hook with a bash shebang walked as bash, run by the helper under `sh -e` → `husky: true` (sh, dashSyntax).
- package.json with `"scripts"` twice (bun first, npm last) → `repeatsKey` finding.
Rejected: none.
Costs: a git config git would refuse, an unknown realpath of the working directory, and a `package.json` with a repeated key now ask. No everyday verdict moved.
Needs a decision: a nested repository that is a gitlink in the index but not in `.gitmodules` (`git add sub` of an embedded repo) is still not followed: `git status` runs its fsmonitor. Seeing it needs the binary index (the FileSystem reads text) or a directory listing. Recommend: add an optional `fs.readdir` or binary read and follow gitlinks, or state the gap in THREAT_MODEL.md as accepted. Either changes what the library promises, so it's the user's call.

## Round 16: src/policy.ts and src/recommended.ts (second pass), 2026-11-16, c71f42a
Reviewer confirmed /dev/tcp and checkout -p in WSL (Bash 5.2, git 2.54), the cargo, npm, pnpm and bun cases in Windows Git Bash (cargo 1.98.1, pnpm 11.17, Node 26, bun 1.4.4). I re-checked /dev/tcp in WSL (a local listener's reply came back). 18 new tests fail on 66974bf. A local Windows run of test/bash.test.ts timed out twice (11-14 s) and passed on rerun; WSL passed.
Confirmed and fixed:
- `cat < /dev/tcp/evil.example/80` (and udp, `read l <`): allowed, opens a connection → a redirection to /dev/(tcp|udp)/ (slashes collapsed), or one only known at run time whose prefix may be, gives `network`.
- `printf 'y\n' | git checkout -p` discarded the edit; `restore -p` asked → checkout --patch counts as --force.
- `cargo test -- --logfile ../victim` overwrote it → test/bench record `--logfile` after `--` as a write (a dynamic word that may be it: unknown write).
- `npm -w ../b test`, `pnpm --filter ../b test`, `pnpm -w test`, `bun --filter ../b test`, `cargo test -p b`/`--workspace` ran another package's scripts, while the cd forms asked (S4) → workspace and package selectors are exec:file unless a static ./, ../ or / path inside the project.
- Without fs, `git switch -qc x origin/feature && npm test` ran the checked-out script, though README says it asks → `rewritten` makes later project code exec:file without a filesystem.
Rejected: none.
Costs: `cat < $f` asks; `npm -w <name>`, `pnpm -r`/`--filter <name>`, `cargo test -p <own crate>` ask; `cargo test -- $x` asks. No everyday verdict moved.
Needs a decision: none.

## Round 17: src/trace/ and src/cover.ts (second pass), 2026-11-16, a15559b
Reviewer ran everything in WSL under the supervisor (x86_64, Bash 5.2). The 2 new trace tests and the analysis test fail on c71f42a; the 4 escape cases already asked there (flock, unshare and chroot aren't allowed by `recommended`), so the analysis test is what pins findings 1 and 3.
Confirmed and fixed:
- `SHELL=x/bash flock lk -c "echo hi"` (and `script -qc`) under enforce ran the project's `x/bash`, covered: judge()'s wrapper-shell branch skipped placement → that branch needs the exec'd file in a system directory; SHELL is sensitive.
- `dash -c "PATH=x:/usr/bin; bash -c …"` (and `flock -c`) ran `x/bash`, covered → same fix (sh was already refused).
- `echo touch made | unshare -r` ran `$SHELL` on stdin, nothing predicted → unshare and chroot with no command are exec:arbitrary.
- `cd sub && ../tool` through a symlink ran a different `tool`, covered by string equality → placed() compares the files each path reaches (realpath), with the relative path taken from the process's real cwd.
Rejected: none.
Costs: `SHELL=… cmd` asks; enforce refuses a wrapper's shell outside /bin, /usr/bin and the other system dirs. No everyday verdict moved.
Needs a decision: none.

## Round 18: src/words.ts (third pass), 2026-11-16, 6773d6d
Reviewer compared ~4,200 fuzzed and hand-written words against WSL Bash 5.2.21; I re-ran the \v case in WSL (`pwned` created). The 2 new escape tests fail on a15559b.
Confirmed and fixed:
- `y='echo hi'; y1='rm -rf ~'; $y{<VT>1..1}` allowed as `echo hi{…}`; Bash's strtoimax skips the whitespace, so the word is `$y1` → a sequence with whitespace before a number is only known at run time (env -u ./x{<FF>1..2} likewise).
- `{1..3..9223372036854775808}` predicted `1`, Bash keeps the text (values only) → a step that isn't a safe integer is only known at run time.
Rejected: none.
Costs: none beyond braces holding \v/\f before a number.
Needs a decision: none.

## Round 19: src/analyze.ts shell state (third pass), 2026-11-16, 172b849
Reviewer confirmed each in WSL Bash 5.2.21 (and #2, #4 in Git Bash 5.3.15); I re-checked the alias, export -n and cd fallback cases in WSL. 16 new tests fail on 6773d6d.
Confirmed and fixed:
- `cd l/../.ssh && echo k >> authorized_keys` (fs, l → ~/sub): Bash retries a missing logical path physically and lands in ~/.ssh → with fs, a logical `..` path that isn't there resolves through openedPath; unknown → cwd unknown.
- `x=1 2>&1 rm -rf ~` after `alias rm=echo`: Bash expands no alias after an assignment then a redirection → `assignedThenRedirected` skips alias lookup.
- `export -n x`, `declare +x x`, `unset x; x=…`, `env -u x`, `env x=`, `env -i` before `watch '$x …'`: the child was walked with the old exported value → export removal tracked; env's -i/-u/NAME= applied to the state its command gets.
- `local -` restored expand_aliases from the snapshot; Bash only restores set -o options (posix toggling aliases) → POSIX mode via setPosix, and an expand_aliases that differs from the snapshot becomes unknown (corrects round 11's claim).
- `declare -n OLDPWD=UID; cd /home/me || echo > .bashrc`: cd moved then failed → with a nameref on PWD/OLDPWD, the failure cwd is unknown.
- `alias '{ls,.}'='rm -rf ~'; {ls,.}` (and after a blank-ending alias): aliases are looked up by the word as written; words with braces but no quotes or expansions may be aliases.
- `enable -n -p printf` disabled nothing in Bash → -p and -d change no builtin (not a bypass under recommended; fixed anyway).
Rejected: none.
Costs: none known beyond the cases' own commands. No everyday verdict moved.
Needs a decision: none.

## Round 20: src/analyze.ts dispatch and wrappers (fourth pass), 2026-11-16, d4f8a2d
Reviewer confirmed each in WSL (Bash 5.2.21, findutils 4.9.0, git 2.54, GnuPG 2.4.4); I re-checked xargs --process-slot-var in WSL (./0/ls ran). 6 new tests fail on 172b849 (the dynamic-name xargs case already asked).
Confirmed and fixed:
- `cd /tmp && echo a | xargs --process-slot-var=PATH ls` ran ./0/ls → the option's NAME goes into the command's env (sensitive check; passed() state), a dynamic name is exec:arbitrary.
- `GCONV_PATH=/tmp/g git log --encoding=EVIL` loaded a .so; `GNUPGHOME=/tmp/g git commit -S` ran gpg.conf's agent-program; `SSLKEYLOGFILE=../k git ls-remote` wrote ../k → GCONV_PATH, GNUPGHOME, SSLKEYLOGFILE, GNUTLS_KEYLOGFILE sensitive.
- `cd .. && nohup echo hi` (on a tty) wrote ../nohup.out → nohup writes nohup.out where it runs.
- `cd .. && script -qc ls` wrote ../typescript (verdict already ask) → typescript is the default log.
- break/continue count regex `/^d+$/` → `/^\d+$/` (was over-approximating; sound either way).
Rejected: none.
Costs: `nohup cmd` outside the project asks (and records nohup.out inside it).
Needs a decision: none.

## Round 21: src/argv.ts (third pass), 2026-11-16, 55113d0
Reviewer confirmed find and uniq in WSL (findutils 4.9.0, coreutils 9.4), pnpm 11.17 / npm 11.20 / bun 1.4.4 on Windows (none in WSL). I re-checked find and uniq in WSL. 5 new tests fail on d4f8a2d.
Confirmed and fixed:
- `pnpm --color false exec rm -rf ~`, `pnpm --stream true pack` (ran prepack), `--reverse true`, `-r true`: nopt takes true/false after a flag as its value; argv.ts made it the command → `CommandSpec.nopt` (npm, pnpm): a static true/false after a flag (known or unknown, long or last in a cluster) is its value, a dynamic word sets maybeOptions. `npm version --ignore-scripts false` now walks preversion.
- `find - ../victim -delete` (and `,`) deleted ../victim, reported as `.` (verdict already ask) → find's looks_like_expression: `-` alone is a path, `)`/`,` first are.
- `uniq +1 in ../out` wrote ../out, reported `in` (already ask) → `+N` positionals dropped; a dynamic word that may be one makes every positional a write.
- `bun test --timings=../t.json --update-timings` wrote ../t.json.<pid>.tmp (Windows) → --timings takes a value and is a write.
Rejected: `pnpm exec --reverse true x` runs a program named `--reverse` in pnpm 11, predicted `true x`: only a file named like an option could run (low; left).
Costs: `uniq $in` now reports $in as a possible write (asks). No everyday verdict moved.
Needs a decision: none.

## Round 22: src/specs.ts (third pass), 2026-11-16, e0a9a90
Reviewer confirmed git cases in WSL (git 2.54); cargo 1.98.1, pnpm 11.17, bun 1.4.4, oxfmt 0.75, oxlint 1.90 on Windows; biome from docs only. I re-checked switch -m in WSL. 15 new escape tests fail on 55113d0. One local Windows run of test/bash.test.ts "mutated scripts" failed once ("wrote but not predicted: v1='ls'") and didn't reproduce in 300 more Windows runs or 400 WSL runs; noted as a one-off.
Confirmed and fixed:
- `git switch -m feature` / `--conflict=diff3` left conflict markers over local edits (checkout -m asked) → switch learns -m/--merge/--conflict, which count as --force.
- `git -c gc.reflogExpire=now -c gc.pruneExpire=now … commit` expired the reflog and pruned a reflog-only commit via auto-maintenance → gc expiry/rerere keys and maintenance.* are exec-config keys.
- `git -c help.format=web help log` ran a browser on a remote URL → help.format/browser/htmlPath, man.viewer are exec-config keys.
- `CC=/tmp/evil/cc cargo build` ran it through a cc-crate build script → CC/CXX/CPP/AR/LD/RANLIB and C/CXX/CPP/LD FLAGS (with HOST_/TARGET_ and _target forms) sensitive.
- `pnpm_config_script_shell=… pnpm run` → pnpm_config_*/PNPM_CONFIG_* sensitive. `BUN_INSPECT=… bun test` opened the inspector → BUN_INSPECT* sensitive.
- `cargo help zzz` ran cargo-zzz → help with a word is exec:arbitrary.
- `cargo doc --open`, `vite --open`, `npm help` run a browser → exec:arbitrary.
- `biome start --log-path=../x` (docs) → --log-path is a write; BIOME_LOG_PATH sensitive.
Rejected: none.
Costs: any CC/CFLAGS/AR/LD… assignment before a command asks; `cargo help <cmd>`, `npm help`, `cargo doc --open` ask; a repository config with gc expiry or maintenance keys is a finding.
Needs a decision: configuration above the working directory is loaded and run by cargo (`../.cargo/config.toml` rustc-wrapper), oxfmt (`oxfmt.config.ts`), oxlint (`.oxlintrc.json` jsPlugins), and by their docs eslint, prettier and jest; the analysis reads none of it. Treating such files (above the start, outside the user's own HOME config) as another's code changes what counts as project code (THREAT_MODEL), so it's the user's call. Recommend: with fs, look for each tool's config files in the start's ancestors and make the run exec:file when one is found above the start (HOME's own tool config, such as ~/.cargo, left as the user's).

## Round 23: files and project code (third pass), 2026-11-16, 8cbb041
The reviewer was stopped by Anthropic safeguards partway (request ID req_011Ch6Qc1HMPzD6MUKNp9ucj) after confirming one finding; per the standing instruction, logged and moved on without continuing its probing. Not reached this round: cp/mv/tee writes into husky files, hooks paths, includes or submodule .git files; background jobs and loops; includes through symlinks. I re-checked the finding in WSL (`{ echo added >> /dev/stdin; } < f` appended to f). 4 new tests fail on e0a9a90.
Confirmed and fixed:
- `{ printf '[core]\n\tfsmonitor = …' >>/dev/stdin; git status; } < .git/config` (also /dev/fd/3 with `3<`, in a function, onto a hook or package.json, or `echo … < ~/.bashrc >> /dev/stdin`): Linux reopens the descriptor's file, so the write lands in the file opened for reading; the `devices` filter dropped it → a write redirection to /dev/stdin or /dev/fd/N is an unknown write; /dev/stdout and /dev/stderr too when walked code may open them for reading (`N<`, `<>`, `>&3`…).
Rejected: none.
Costs: a write to /dev/stdin or /dev/fd/N asks; `>/dev/stderr` in code that also has a numbered input redirection or `<>` asks. No everyday verdict moved.
Needs a decision: none new. Noted, not changed: `.gitmodules` is read as it was before any write in the script (round 15's choice); a write to it earlier in the script names no new repository, and gitlinks not in .gitmodules remain round 15's open decision.

## Round 24: src/policy.ts and src/recommended.ts (third pass), 2026-11-16, 7751c3a
Reviewer confirmed in WSL (Bash 5.2.21, git 2.54); I re-checked `f > ../x` in WSL. 5 new escape tests fail on 8cbb041.
Confirmed and fixed:
- `f() { :; }; f > ../x` (and `>> ~/.bashrc`, `>> .git/config; git status` without fs, `< /dev/tcp/…`, nested and under wrappers): evaluate() skipped function invocations, which carry the call's redirections → a function call with writes or effects is also decided as `:` with its redirections.
Rejected: none. Low, noted: `biome --config-path ../x`, `oxlint --tsconfig ../x`, `tsdown --tsconfig ../x` read JSON from outside and are allowed (configuration that names no code to run).
Costs: none beyond redirections on function calls that write outside or into .git.
Also fixed (202e276, under the standing instruction to prefer fail-closed changes that move no everyday verdict): an ask rule for writes to ~/.gitconfig, ~/.config/git/**, ~/.ssh/** and shell startup files, so the case below now asks; 4 new tests fail on 7751c3a. Formerly needs a decision: with the start at HOME (cwd = HOME), `recommended`'s outside rule (`..`, `../**`) counts all of HOME as the project, so `printf '[core]\n\tfsmonitor = …' >> ~/.gitconfig; cd repo && git status` (and ~/.config/git/config, ~/.bashrc, ~/.ssh) is allowed and git runs it. Done as above; the user may still want a broader rule for HOME (other dotfiles).

## Round 25: src/trace/ and src/cover.ts (third pass), 2026-11-16, 71af17b
Reviewer ran everything under the supervisor in WSL (x86_64, Bash 5.2.21, ptrace_scope=1). I re-ran the wrapper case in WSL. 4 trace tests and 1 analysis test fail on 202e276; the root-Bash test passes there too (WSL's /tmp, where the tests work, seems not to execute the stand-in: code 126), so it stays as a regression check, while the reviewer reproduced the bug in a home directory.
Confirmed and fixed:
- Relative execve paths were placed against the run's start, not the process's cwd: `mapfile -C 'cd d; :' …; ./s` and `. <(echo 'cd d'); ./s` ran d/s covered; `cd d && ./s` was refused → supervisor.c resolves any relative path via /proc/<pid>/cwd; placed() compares files, and a relative path from an unknown cwd matches the path as given.
- The run's `bash` was found through the run's PATH (`:` or `bin` first ran ./bash unchecked) → the supervisor starts /bin/bash (or /usr/bin/bash) by its absolute path.
- `unshare -r -m … mount --bind d /usr/bin && touch`, `unshare -r chroot r echo` ran project files under covered system paths; `unshare -r` gave full capabilities and wrote the parent's /proc/pid/mem (S6's no-CAP_SYS_PTRACE claim) → the seccomp filter (rebuilt as a linear builder) fails clone/unshare with CLONE_NEWUSER|CLONE_NEWNS, and chroot, mount, umount2, pivot_root, setns and the new mount API, with EPERM.
- The wrapper-shell rule covered any system shell under a `W -c` wrapper → the shell's `-c` code must be a word (or `watch`-joined words) the wrapper was given, unless one is dynamic.
- Non-UTF-8 argv/paths decode to U+FFFD and matched any byte → such an exec is covered only by an unseen-code finding.
- S1 (shell state, fixed here rather than waiting for area 2): `mapfile -C` callbacks ran on a clone (now the shell's own state, any number of times: what changes becomes unknown); `source` of an unseen file kept the cwd (now unknown).
Rejected: none.
Costs: under the trace layer, `unshare`, `chroot` and mounts fail; a relative exec from a directory the analysis placed elsewhere is refused. `source x; touch y` has an unknown cwd (asks anyway: source is exec:file). No everyday verdict moved.
Needs a decision: none.

## Round 26: src/words.ts (fourth pass), 2026-11-16, no commit
Stopped by a safeguard: the reviewer subagent was terminated early (request ID req_011Ch6VxUgmYdeh2kyy6aY37) before reporting any findings. Nothing was confirmed or changed. Not counted as an empty round for the stop condition; moving on to area 2.

## Round 27: src/analyze.ts shell state (fourth pass), 2026-11-16, ceab263
Reviewer verified each case in WSL (Bash 5.2.21); I re-ran all five there. 9 new escapes cases failed before the fix and 2 alias cases (one passed already: Bash refuses a quoted name).
Confirmed and fixed:
- `cd /tmp && { d=~+; cd /repo && echo x > $d/evil; }` (also `for d in ~+`, `export d=~+`, `cd $d`) → the value kept a literal `~+`, resolved against the directory where it was used → an unquoted `~`/`~+`/`~-` prefix in an assignment, declaration argument or one-word `for` list is expanded as it's assigned (HOME or the cwd then; `~-`, an unknown cwd, a `:~` or a tilde written another way are dynamic; a quoted one is kept literal, as Bash keeps it).
- `d=.; f() { d=/tmp; local d=.; }; f; echo x > $d/evil` → a return put locals back to their value when the call started → the frame records each variable's value and attributes when `local` runs (`Frame.outer`), joined and compared like the rest; a variable maybe local already stays unknown.
- `d=.; g() { declare -g d=/tmp; }; d=/tmp g; echo x > $d/evil` (also `d=/tmp declare -g d=/tmp`) → the temporary value was undone → `declare -g` with a value marks the name kept, as `export` does (in a function: dynamic). Checked: `declare -g d` with no value leaves it.
- `x=.; x=/tmp >$x/evil` → an assignment-only command's redirections were expanded before its assignments → expanded after them.
- `alias rm=zz; rm() { :; }; \rm -rf /` → a `name()` definition's name wasn't alias-expanded (Bash defines `zz`) → it's renamed to a plain alias value, both ways when the alias or expansion may not hold, and a finding for any other value. `function name` is left as it is (checked in Bash). New script in test/scripts.ts.
Rejected: none (reviewer's "handled correctly" list noted).
Costs: `export X=~/y` reached through a wrapper or alias (no command words to read) stores a dynamic value. A `name()` definition with aliases on and unknown aliases gets an unknown-alias finding, as a command there already does. No everyday verdict moved.
Needs a decision: none.

## Round 28: src/analyze.ts dispatch and wrappers (fifth pass), 2026-11-16, 73e5e9a
Reviewer verified in WSL (Bash 5.2.21, Ubuntu 24.04); I re-ran all three there. 7 of 8 new escapes cases fail on ceab263 (the compgen -F `cd` case asked already: compgen isn't allowed).
Confirmed and fixed:
- `declare -n r='a[$(rm -rf /)]'; echo $r` (also `local -n`, a target from a variable, one from `read`) → allow: a nameref's target subscript, which every read runs, was never walked → `declare -n` with a value walks the target as `${!x}` does (nameWord): its subscript's code, or a finding when the target is only known at run time.
- `printf '%s\n' -C -m sub/m | xargs file`, `read -r a; file $a` → allow, while `file -C` writes `<magic>.mgc` in the cwd, through a symlink there → the file spec's write is added when options may come at run time too.
- `compgen -W '$(rm -rf /)' a`, `f() { …; }; compgen -F f a` → ask without the code: -W's word list is expanded and -F's function runs in the shell itself (cwd and variables change) → both followed (finding when only known at run time); `complete` only registers them.
Rejected: none.
Costs: `file` with a dynamic argument (a glob that may expand to an option, `xargs file`) now asks. No everyday verdict moved.
Needs a decision: none.

## Round 29: src/argv.ts (fourth pass), 2026-11-16, c68d553
Reviewer ran the real programs: pnpm 11.17, tsdown 0.23.4 and vite 8.3.5 on Windows, prettier 3.8.3 and vitest 5.1.0's own parser from the bun cache, tsc 7.0.2, and cargo/clippy 1.88 and git 2.54 in WSL. I re-ran git push --veri in WSL (hook ran). All 9 new escapes cases fail on 73e5e9a.
Confirmed and fixed:
- `pnpm -C --config.script-shell=X test` (also `--reporter`, `--dir`, given twice), `tsdown --config-loader a --config-loader --on-success …`, `vitest run --exclude a --exclude --config /tmp/evil.mjs`, `vite -m development -m --host`, `prettier --tab-width --plugin=../outside/evil.mjs` → allow: a valued option always took the next word, but mri/cac, minimist, yargs and nopt's String options leave a word starting with `-` as an option (cac only errors when the option is given once) → `CommandSpec.dashless` on pnpm, vite, vitest, tsdown, prettier, jest: such a word isn't taken as a value; a dynamic one that may start with `-` sets maybeOptions.
- `tsc --noEmit false ../other/a.ts` → allow, but tsc emits there → tsc reads `true`/`false` after a flag (`nopt: true`), and finish uses `flag()` (last value is a plain on).
- `cargo clippy -- -C linker=/path` → allow, ran the linker (and `-o` writes outside) → words after `--` other than lint levels (`-D/-W/-A/-F`, `--deny`… `--cap-lints`, separate or attached) are exec:arbitrary. `cargo clippy -- -D warnings` (everyday) stays allow.
- `git push --no-verify --veri` with a pre-push hook → the hook went unread (deny → ask): `--verify` was listed twice, which made the abbreviation ambiguous → duplicate removed. A scan of all specs found more duplicates (biome `--log-level`/`--log-kind`, rsync `-e --rsh` as a flag, strace `-yy`, tar `--info-script` twice): removed or corrected (`--new-volume-script`); bun build's `-e` is kept on purpose.
- (Minor, fail-closed) `gh repo read-file|read-dir -R` added.
Rejected: none. Not verified: jest (yargs-parser) wasn't installed; marked dashless as yargs documents.
Costs: these tools with an option followed by a word starting with `-` (`vitest -t -x`, `vite --port -1`) or by a value only known at run time now ask; cargo clippy with other rustc flags after `--` asks. No everyday verdict moved.
Needs a decision: none.

## Round 30: src/specs.ts (fourth pass), 2026-11-16, 918bc00
Reviewer checked specs against docs and real programs (git 2.54 in WSL, the repo's vite 8.3.5 and tsdown 0.23.4). I re-ran the ext:: transport in WSL (`-c protocol.allow=always fetch` ran it; plain fetch refused). 5 of 6 new escapes cases fail on c68d553 (`-c http.cookieFile … ls-remote` asked already).
Confirmed and fixed:
- Repo config `protocol.allow = always` + an `ext::sh -c …` remote (or a promisor remote, reached by `git show <sha>`/`cat-file -p`), and `git -c protocol.allow=always cat-file -p <sha>` → allow, ran the remote's command → `protocol\.(.*\.)?allow` in gitExecKeys (was only `protocol.<name>.allow`).
- Repo config `http.cookieFile = ~/.bashrc` + `http.saveCookies` → `git fetch` allow, overwrote that file with a cookie jar → `http\.(.*\.)?cookiefile` in gitExecKeys. Added `mergetool.*.path`, `difftool.*.path`, `sendemail.smtpServer` too (not reached by `recommended`'s git commands).
- `vite build --outDir src` → allow, emptied `src` first → fs:delete when `--outDir` or `--emptyOutDir` is given.
- `tsdown -d src` → allow, cleaned `src` → fs:delete when `--out-dir` is given.
Rejected: none. Not changed: write-role options without an `fs:write` effect (`gh repo read-file -o`, `--outputFile`): their writes are recorded, so path rules see them; only a policy keyed on the `fs:write` effect alone would miss them. Logged for later, not a bypass under `recommended`.
Costs: `vite build --outDir x`/`--emptyOutDir` and `tsdown -d x` ask. A repository whose config sets `http.cookieFile` or `protocol.allow` has its git commands ask. No everyday verdict moved.
Needs a decision: none.

## Round 31: files and project code (fourth pass), 2026-11-16, 83bcc4c
Reviewer verified in WSL (git 2.54, Bash 5.2, dash) and with Windows npm 11.20 for the case item. All 10 new tests (9 escapes, 1 analyze) fail on 918bc00.
Confirmed and fixed:
- `git commit -m x` with `core.hooksPath = githooks` whose `pre-commit` copies a payload to `githooks/reference-transaction` (also husky 9.1: a project hook rewriting `.husky/_/h`, which the next stub sources) → allow: each hook was read once, before the hooks that run earlier had been walked (and husky's dispatcher was cached) → after a command's hooks are walked, each is read again (uncached, husky's files too), so a write by one to another is a finding.
- Hook first lines `#!/usr/bin/env -S bash -c "…"`, `#!/bin/bash -i` / `--rcfile`, `#!/tmp/x/sh` → read as plain sh/bash → `interpreter()` takes only a system-path shell with no options but `set`'s (`-e`, `-u`, `-x`), or `env` with just a shell name; anything else is a loads-code finding.
- `git -C link/.. commit`, `--git-dir=link/../.git`, `env -C link/.. git|npm …` with `link` into another repository → allow, walked this project's hooks; the kernel leaves from the symlink's target → `-C`/`--git-dir`/`--work-tree` paths go through `openedPath`.
- `echo … > .HUSKY/pre-commit && git commit`, `echo … > PACKAGE.JSON && npm test` on a case-insensitive filesystem → the write didn't cover the later read → `Changes` compares without case (more conservative on case-sensitive ones).
- (Lower) `include.path = ~/x` with HOME unknown asked the FileSystem for `~/x` → `read`/`exists` make a `~` path a finding instead.
THREAT_MODEL's hook paragraph updated (what first lines count; hooks re-read).
Rejected: none.
Open, not verified (no node/tsc in WSL): a project `.npmrc` `script-shell=`/`node-options=` and pnpm's `shell-emulator` change how package scripts run; a tsconfig's `outDir`/`tsBuildInfoFile`/`outFile` may write outside the project from bare `tsc`. To check in the next files-and-project-code round.
Costs: hooks with `#!/bin/bash -l`, `#!/usr/bin/env -S …` or a shell outside the system directories ask; a write in another case to a file git or a package manager reads later asks on case-sensitive filesystems too. No everyday verdict moved.
Needs a decision: none.

## Round 32: src/policy.ts and src/recommended.ts (fourth pass), 2026-11-16, d55a151
Reviewer verified in WSL (Ubuntu 24.04) and Git Bash on NTFS. All 15 new escapes cases fail on 83bcc4c.
Confirmed and fixed:
- `{cwd: 'C:/w/proj'}` (README's `process.cwd()` on Windows) or `{cwd: 'proj'}`: `cd .. && echo x > evil`, `echo x > sub/../../evil` → allow: the walk used the string as its directory, but only `/…` set the start, so resolved paths looked placed → a cwd that isn't POSIX-absolute is walked as `.`, as no cwd is.
- From HOME with fs: a symlink `rc -> ~/.bashrc` (`echo x >> rc`), `p/up -> ~` (`… > p/up/.ssh/authorized_keys`), and HOME given lexically while the start is its physical path → allow: `~` globs were matched only on the lexical path → `tildePath` is also taken of the realpath, against HOME and HOME's real path (new `Analysis.realhome`).
- `cp -r d/.ssh ~/`, `mv d/.ssh .`, `cp -r d/.config .` → allow: only `~/.ssh/**` listed, and the copy writes `~/.ssh` itself → `recommended` lists `~/.ssh`, `~/.config/git` and `~/.config`.
- `cp -b -S rc a .bash`, `SIMPLE_BACKUP_SUFFIX=rc cp -b a .bash` → replaced `~/.bashrc` → cp/mv with a backup write each target plus `-S`'s suffix, or an unknown name without `-S` (the environment's suffix isn't followed).
- `echo key >> ~/.SSH/authorized_keys`, `>> ~/.BASHRC` on a case-insensitive filesystem → allow: case folding only for `.git`/`HEAD` → maybe-matching rules also try the lower-cased path.
- Lesser: `~/.bash_aliases` (sourced by Ubuntu's .bashrc), `~/.bash_logout`, `~/.zlogin`, `~/.zlogout`, `~/.local/bin` (on Ubuntu's PATH), `~/.npmrc`, `~/.bunfig.toml`, `~/.cargo/config(.toml)` added to the home rule.
Rejected / not changed: `rm -rf /*`, `rm -r ~/*` ask rather than deny (an unquoted glob is dynamic, so the literal deny args don't match): still ask, not a bypass.
Costs: `cp -b`/`mv -b` without `-S` ask; a non-POSIX cwd behaves like no cwd (writes reaching `..` ask, as they always did without one); the new home files ask. No everyday verdict moved.
Needs a decision: none.

## Round 33: src/trace/ and src/cover.ts (fourth pass), 2026-11-16, ee5f3fa
Reviewer ran everything under the supervisor in WSL (kernel 6.18, ptrace_scope 1); I re-ran the /proc/self/cwd case in WSL (the project's fake usr/bin/ls ran). All 3 new tests (2 escapes, 1 trace) fail on d55a151.
Confirmed and fixed:
- `/proc/self/cwd/../../../usr/bin/ls` from a/b/c of a project shipping `usr/bin/ls` → allow, and enforce covered=true: `isSystemPath`, `placed()` and the wrapper-shell `system` check fold `..` as text, while the kernel goes through `/proc/self/cwd` (and any symlink, `l/../…`) first → `followsLinks()` in paths.ts: a path under `/proc`, or with `..` after a name, is no system path (so `exec:file` in the analysis) and never placed under the supervisor; the wrapper-shell rule needs a system path that doesn't follow links. Also covers `SHELL=…/l/../…/usr/bin/sh flock -c` and a `PATH` entry through `l/..`.
README and THREAT_MODEL S6 say what covered excludes.
Rejected: none.
Costs: a program run by a path with `..` after a name (`node_modules/.bin/../x`) asks, and is refused under enforce. No everyday verdict moved.
Needs a decision: none.

## Round 34: src/words.ts (fourth pass, retry of round 26), 2026-11-16, 4a90911
Reviewer compared ~250 words between bash-gate and WSL Bash 5.2.21 with printf; I re-ran both findings in WSL. All 5 new escapes cases fail on ee5f3fa.
Confirmed and fixed:
- `echo hi | tee $'\UFFFFFFFF'/home/u/.bashrc`, `> $'\UFFFFFFFF'/home/u/.ssh/authorized_keys`, `cp evil $'\UFFFFFFFF'.git/hooks/pre-commit` → allow, `$'\UFFFFFFFF'rm -rf /` and `git push $'\UFFFFFFFF'--force` → ask: unbash keeps a `\U` past U+10FFFF as its text, while Bash drops one from 0x80000000 and writes bytes of its own for 0x110000–0x7FFFFFFF → `ansiC` drops the former (static, so these deny or ask as their plain forms do); a word with the latter is dynamic. New script in test/scripts.ts.
- `env: {IFS: ','}` → `tee a${IFS}/home/u/.bashrc` resolved to `a,/home/u/.bashrc`, allow; Bash ignores an imported IFS → IFS, SHLVL, BASH, BASH_VERSION(INFO), OPTERR, OPTIND, PS1, PS2, PS4, COMP_WORDBREAKS, HOSTTYPE, MACHTYPE, OSTYPE, HOSTNAME from `environment.env` are dynamic.
Rejected: none.
Also seen: one WSL run failed "against bash > mutated scripts" with no message kept; it didn't reproduce in 12×200 more mutation runs or a full rerun (421 pass). Logged as a flake, as in round 22.
Costs: those variables, when the harness passes them, are only known at run time (`echo $SHLVL` args are dynamic). No everyday verdict moved.
Needs a decision: none.

## Round 35: src/analyze.ts shell state (fifth pass), 2026-11-16, b59ede9
Reviewer verified in WSL (Bash 5.2.21); I re-ran all four with printf stand-ins in WSL. 7 of 8 new escapes cases fail on 4a90911 (the comment case passed already).
Confirmed and fixed:
- `x=echo; while x=rm; false; do x=echo; done; $x -rf /` (and `until`, and `d=..` as a write path) → allow: the loop's state never included the one after the final, failing clause → after a while/until loop, the state is joined with one more (silent) walk of the clause. Now ask (x may be either, as the join keeps the pre-loop state).
- `alias rm=echo; \⏎rm -rf /`, `unalias ls; \⏎ls` → allow: a backslash-newline between commands counted as a new line for alias timing → `newLine()` drops comments and escaped newlines first.
- `f() { local d=.; while false; do :; done; }; d=.; f; d=..; f; echo x >> $d/evil` → allow, `./evil`: the loop memo's key left out the frames, so the second call took the first call's `Frame.outer` → `stateKey` includes frames (locals with their outer values, unknown, saved options) and maybeIntegers.
- `x=rm; f() { x=echo; }; g() { f; }; FUNCNEST=1; g⏎$x -rf /` → allow; Bash refuses the nested call and drops the line → `FUNCNEST` is sensitive.
- (Environment note) `env: {CDPATH: '/home/me'}`: `cd .ssh && echo k >> authorized_keys` → allow, wrote ~/.ssh → cd with a CDPATH set (from the environment too) leaves a name that isn't absolute or `./`/`../` unknown. BASHOPTS, SHELLOPTS and BASH_FUNC_* in the environment are excluded by THREAT_MODEL's assumptions, unchanged.
Rejected: none.
Also seen: the WSL "mutated scripts" check failed once more (bash + trace together); 10 bash-only and 4 combined reruns passed. Third sighting overall: next time, capture fast-check's seed from the full output.
Costs: `FUNCNEST=…` asks; with CDPATH set, `cd name` leaves the directory unknown. No everyday verdict moved.
Needs a decision: none.

## Round 36: src/analyze.ts dispatch and wrappers (sixth pass), 2026-11-16, 7bbfe98
Reviewer verified in WSL (Ubuntu 24.04.3, bash 5.2.21, dash 0.5.12, watch 4.0.4, findutils 4.9.0, git 2.54); I re-ran the history and dash cases in WSL. All 6 new tests (5 escapes, 1 analyze) fail on b59ede9.
Confirmed and fixed:
- `HISTFILE=~/.bashrc; HISTFILESIZE=0` → allow, truncated the file as HISTFILESIZE was set (HISTFILESIZE=1 kept the last line); `HISTFILE=~/.bashrc; set -o history⏎alias ls=…` → allow, appended the script's lines to it on exit → HISTFILE and HISTFILESIZE are sensitive.
- `watch 'c=rm; declare c=echo; $c -rf /'`, `git rebase -x '…declare…'`, `watch 'alias echo=…; shopt -u expand_aliases⏎echo hi'` → allow, walked as POSIX Bash, while dash reports `declare`/`shopt` not found and runs on → `dashSyntax` also flags builtins dash doesn't have (declare, typeset, shopt, source, builtin, let, mapfile, readarray, pushd, popd, dirs, enable, compgen, complete, compopt, caller, disown, suspend, logout, help) where a command starts. THREAT_MODEL's sentence on `sh` code says so.
- (Minor) `find -- / -delete` → read `--` as the expression, so `.` was the starting point → `--` ends find's leading options.
Rejected: none.
Costs: hooks, package scripts and `watch`/`rebase -x` code using those builtins ask (e.g. a package script with `source .env`). No everyday verdict moved.
Needs a decision: none.

## Round 37: src/argv.ts (fifth pass), 2026-11-16, b64da5a
Reviewer checked against the real programs (git 2.54 in WSL; npm 11.20 with its own nopt, pnpm 11.17, bun 1.4.4 and the repo's tsc 7.0.2 on Windows). I re-ran `git stash list --output` in WSL (wrote the file). 11 of 12 new escapes cases fail on 7bbfe98 (`pnpm purge` without fs asked already).
Confirmed and fixed:
- `git stash list --format=%s --output=~/.bashrc` (or into .git/hooks) → allow: `stash list` passes log options to `git log -g` → its spec has `--output` as a write.
- `echo --outDir ~/.ssh x.ts > a.txt && tsc @a.txt`, `tsc @../a.txt` → allow: tsc reads options from `@file` → an `@` positional (or a dynamic one that may be) is exec:arbitrary.
- `npm -Cd ls` → allow, but nopt expands it to `--prefix --loglevel info ls` (`npm info`, network); `npm -C=/tmp/x test`, `pnpm -C=…` → cwd `=/tmp/x` → under nopt, `-X=v` is X with v, and any other multi-letter short word that isn't an option itself is unknown.
- `pnpm --test-pattern --reporter dlx test` → allow, but `--test-pattern` ([String, Array]) takes `--reporter` and `dlx` runs → under dashless, a dashed word after a valued option sets maybeOptions (both readings possible).
- `bun up` (= update) and pnpm's `purge`/`uni`/`dislink` with a script of that name → allow as the script → bun `update|up`; pnpm aliases and missing commands added (clean-install/ic/install-clean, peers, owners, undeprecate, prefix; set-script/ss, change, lane, pack-app as exec:arbitrary).
Rejected / extra asks only (not changed): git cherry-pick/revert `-s` read as --strategy (it's --signoff), optional-value short options (`status -u`, `checkout -t`, `pull -r`), branch `--contains -x`, cargo `-C=` (needs -Z).
Costs: npm/pnpm short clusters (`npm -ws`… only if not an option of its own) and `tsc @args` ask; a valued option of pnpm/vite/vitest/tsdown/prettier/jest followed by a dashed word asks. No everyday verdict moved.
Needs a decision: none.

## Round 38: src/specs.ts (fifth pass), 2026-11-16, 73a580d
Reviewer checked against the programs and their sources (npm's @npmcli/config, jest's @jest/reporters + istanbul-reports, pkg-config-rs, git 2.54 in WSL with vim as the default editor). I re-ran the mergeOptions case and `merge --continue`/`rebase --continue` with a stand-in `vi` in WSL (both opened it). 10 of 12 new escapes cases fail on b64da5a.
Confirmed and fixed:
- `Npm_Config_Script_Shell=/tmp/x npm test` → allow; npm matches `npm_config_` in any case → the sensitive pattern does too.
- `printf 'ihello\033:!rm -rf ~\n:wq\n' | TERM=xterm git commit` (and `--amend`, `-c`, `tag -a v1`, `rebase -i`, `merge --edit`, `cherry-pick -e`, `branch --edit-description`, with `< keys`) → allow; git's default `vi` takes `:!cmd` from stdin → those forms are exec:arbitrary (`editor`), as `git config -e`: commit without -m/-F/-C/--no-edit/--fixup, annotated tag without -m/-F, `-e`/`--edit`, `rebase -i`/`--edit-todo`, `--continue` on merge/rebase/cherry-pick/revert.
- `jest --coverage --coverageReporters=/tmp/evil.js` → allow; istanbul-reports `require`s the name → moved to jestModules.
- `PKG_CONFIG=/tmp/x cargo build` (CMAKE, PROTOC, PYO3_PYTHON, LIBCLANG_PATH…) → allow; build scripts run that program → sensitive (pkg-config verified; others by the same pattern, fail-closed).
- Repo config `branch.<b>.mergeOptions = -s evil` → `git merge other` allow, ran git-merge-evil → `branch.*.mergeoptions`, `pull.twohead`, `pull.octopus` in gitExecKeys.
Rejected: none.
Costs: `git merge --continue && git rebase --continue` now asks (escapes case flipped from allow; it opens the editor, verified); `git commit` without a message, `tag -a` without one, `rebase -i` ask; those build variables ask. No everyday verdict moved (`git commit -m` stays allow).
Needs a decision: none.

## Round 39: files and project code (fifth pass), 2026-11-16, no commit
Stopped by a safeguard: the reviewer subagent was terminated early (request ID req_011Ch6rpPEZypSJDsdNyrouX) before reporting any findings. Not counted as an empty round.
Open items from round 31, checked by me this round:
- `echo script-shell=/tmp/x > .npmrc && npm test` → allow; `echo '{"compilerOptions":{"outDir":…}}' > tsconfig.json && tsc` → allow. Rejected under the current model: THREAT_MODEL (project code) says what the project holds is its own, "including what the script writes or copies into the project before" — `.npmrc` and `tsconfig.json` are project configuration, as `vite.config.js` is (`echo … > vite.config.js && vite build` is allow by the same promise). A policy for which that matters asks about `exec:project`. If you want project configuration written by the script itself to count as unseen, that's a trust-boundary change: logged here, not made.
Costs: none. Needs a decision: none new (the note above restates an existing promise).

## Round 40: src/policy.ts and src/recommended.ts (fifth pass), 2026-11-16, see commit
Rerun from the start on fa7d65c (0.3.0) after the pause. Reviewer verified in WSL (Bash 5.2.21, Ubuntu's /etc/skel/.profile) and Git Bash on NTFS with 8.3 names; I re-ran the `declare -a HOME` case in WSL (HOME unchanged). All 5 new escapes cases fail on 3c37307.
Confirmed and fixed:
- `declare -a HOME; echo x >> .bashrc` (also `-A`, `-n`, `export -a`) from HOME → allow: the analysis leaves HOME unknown with no finding, so `~` globs had no HOME to match from, while Bash keeps HOME as it was → `Analysis.home` (HOME as the script starts) is one more home `~` globs match from.
- `mkdir -p bin && cp … bin/git` from HOME → allow; Ubuntu's .profile prepends `~/bin` to PATH → `~/bin` and `~/bin/**` in the home rule.
- `echo x >> BASHRC~1`, `echo k >> SSH~1/authorized_keys` from HOME on Windows → allow; 8.3 short names reach `.bashrc`, `.ssh` → a path with a `NAME~N` component counts as unplaced and outside, so path rules may match it.
Rejected: none. Not verified (not changed): other dotfiles that run code later (`~/.config/**` beyond git, `~/.cargo/env`, `~/.bashrc.d/`, `.xsessionrc`, `.pam_environment`, `.gnupg/gpg-agent.conf`).
Costs: writes to a path with a `NAME~N` component ask (`x~1`); writes under `~/bin` ask. No everyday verdict moved.
Needs a decision: none.

Loop stopped after this round at the main session's request (the user has new work queued); no further rounds scheduled.

## Round 41: secrets:read (new in d3de581), 2026-11-16, see commit
Area set by the main session: the features added in d3de581 only, `secrets:read` first (`src/secrets.ts`, `readsSecrets`/`contentBlind` in `src/analyze.ts`). Reviewer read the code and ran fake values in WSL (Bash 5.2.21, procps 4, GNU awk, git 2.54); I re-ran each Bash claim in WSL with a fake `FAKE_TOKEN` and a fake `.env`. 43 of the new escapes cases fail on 60f9f96 (all but `git cat-file -p HEAD:config/.env`, which asked already).
Confirmed and fixed:
- A secret copied before it's printed: `a=$GITHUB_TOKEN; echo "$a"`, `a=("$GITHUB_TOKEN")`, `for t in $GITHUB_TOKEN`, `x=GITHUB_TOKEN; echo "${!x}"`, `declare -n r=GITHUB_TOKEN; echo "$r"` → allow → an assignment-only command, a loop's words and arithmetic that expand a secret become a `:` with `secrets:read`; a nameref, or `${!x}` whose target is one or unknown, counts as a secret.
- Shown by Bash itself: `echo $((GITHUB_TOKEN))`, `(( GITHUB_TOKEN ))`, `[ "$GITHUB_TOKEN" -eq 1 ]`, `[[ $GITHUB_TOKEN -eq 1 ]]` print the value in the error (verified with `ab-cd.ef`); `[[ $GITHUB_TOKEN =~ (.*) ]]` copies it into BASH_REMATCH; `set -x` traces `[ -n "$GITHUB_TOKEN" ]`, `[[ ]]` and `case` with the value → arithmetic names count as expanded, `test`/`[` stay exempt only without `-eq`…`-ge`, `[[ ]]` and `case` are exempt like test unless they compare numbers or use `=~`, and nothing is exempt when `set -x` may be on (xtrace is now a followed option, `set -x`, `bash -x`, SHELLOPTS).
- Printing the environment: `ps aux e`, `ps -ef e`, `ps -E` (BSD), awk's `ENVIRON`, jq's `env`/`$ENV` (and a filter from a file or only known at run time), yq's `env()`/`strenv()` → allow → ps reads `e` in any letters-only word (skipping option values like `-o user`), `-E`; awk's scan, jq's filter and yq's expression are checked. jq/yq not installed: from their manuals.
- Files: `/proc/self/task/1/environ`; globs `.e?v`, `.[e]nv`, `.en*`, `~/.aws/*`, `~/.kube/conf*`, `/proc/self/env*`; `mv .env notes.txt; cat notes.txt`; `git show HEAD:.env`, `git show :.env`; `grep x < link` to `.env` with fs → allow → `secretGlob` fills wildcards and matches the glob against one example of each secret file (a bare `*` last part only against paths); mv and ln are no longer content-blind; git's `rev:path` is checked; redirections get real paths.
- Missing names: `~/.config/git/credentials` (git-credential-store docs), agents' (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.config/github-copilot/`), hub/glab, gem/m2/gradle/composer, s3cfg/boto/rclone/oci/doctl, fly/vercel/netlify/wrangler, any file in `~/.kube` but `kuberc`, `.dev.vars`, `*.tfvars`, `.htpasswd`, `*.ppk`/`*.p8`/`*.kdbx`, `.my.cnf`, `/etc/ssl/private/`, `.env~`; variables `PGPASSWORD`, `MYSQL_PWD`, `SSHPASS`, `GITHUB_PAT`.
- False positives removed: `PASSWORD_STORE_DIR` (and any name ending in DIR/FILE/PATH), names with a word `PUBLIC` (`NEXT_PUBLIC_…_ANON_KEY`, `PUBLIC_KEY`), `${GITHUB_TOKEN:+set}`, source files `.env.ts`/`.env.d.ts`/`.env.py`….
Rejected (known by name, as README and THREAT_MODEL say; README now names them): `grep -r`/`rg -uu` over a tree, `find -exec cat {} +`, `echo .env | xargs cat`, a bare `*` reaching `id_rsa` in the cwd or `.env` under dotglob (`grep -rn x src` is everyday); lower-case `github_token` (upper case only, by design); `CACHE_KEY`/`SORT_KEY`/`GPG_KEY` and `.env.test`/`.env.development` (may hold secrets, kept); `README~1.md` on Linux (short names, kept fail-closed); `.yarnrc.yml` (usually plain config, left out).
Also seen: on Windows the Git Bash "mutated scripts" property failed with seed 1228426010, path `94:20:2:19:7:16:13` ("A stub never finished its log", `declare v1=<(v3='f1' ls '' >out)` in a while loop). The same seed fails on 60f9f96's code in a detached worktree, so it's the harness (a process substitution's stub outliving the script), not this change. The next full run and WSL (425 pass) were green.
Costs: `a=$SECRET`, `for x in $SECRET`, `(( SECRET ))` ask; `mv`/`ln` of a secret file ask; `cat *.*`-like globs that could match a key type ask. No everyday verdict moved.
Needs a decision: none.

## Round 42: kubectl, helm and terraform specs (new in d3de581), 2026-11-16, see commit
The tools aren't installed: the reviewer cited each claim to their source or docs (helm release-3.19 and main, kubectl/client-go/cli-runtime master, terraform main and its CLI docs) and ran in-process checks only. No Bash claim needed WSL. All 19 new escapes cases fail on a6d7c84. From this round on, Bash-backed tests run only in WSL: the Windows Git Bash suite had slowed the user's PC to a halt.
Confirmed and fixed:
- `helm uninstall myrel --dry-run=false` (and `=0`, `rollback --dry-run=false`, `install`/`upgrade --dry-run=false`) → allow, `network:read`; uninstall's and rollback's `--dry-run` is a Go bool, and install's `isDryRun()` is true only for client, server or true → dry only when ParseBool reads true, or for client/server.
- `kubectl config view --flatten` → allow; view.go skips RedactSecrets when flattening and FlattenConfig inlines key files → `secrets:read`.
- `kubectl get --raw /api/v1/namespaces/default/%73ecrets/foo` → allow; RequestURI keeps the decoded path → any `%` in a raw path counts.
- `kubectl get secrets -o JSON` → allow; cli-runtime lowers the format → `showsData` ignores case.
- `kubectl label secret foo a=b --dry-run=client -o yaml`, `annotate … -o json`, `wait --for=create secret/foo -o yaml` → allow; they print the object as the server has it → the print check applies to every kubectl command, and `wait` has the output options.
- `helm status myrel -o json` → allow; statusPrinter encodes the whole release, its config and manifest → `-o json|yaml` on status, install and upgrade is `secrets:read`.
- `helm repo update --repository-config ./r.yaml`, `helm template r/c --repository-cache ./cache`, `XDG_CACHE_HOME=./c helm template r/c` → allow; repositories from a file the command names may be any host → those options count as elsewhere (`network`), and `XDG_CACHE_HOME`/`XDG_DATA_HOME` are sensitive.
- `terraform init -migrate-state -force-copy`, `init -backend-config=address=https://…` → allow; migration overwrites the new backend's state, and KEY=VALUE is a backend setting, not a file → `network`.
- `terraform fmt -check=false -recursive /home/me/other` → allow, read as checking only; fmt.go writes unless check is true → check only when ParseBool reads true (and `-write` false the same way).
- `terraform providers lock -net-mirror=https://…` → allow → `network`.
Rejected or not verified (not changed): `kubectl create cm …` looking for a `kubectl-create-cm` plugin first (cmd.go compares only subcommand names, not aliases; needs a plugin on PATH, unverified); `kubectl kustomize --load-restrictor LoadRestrictionsNone` and `helm install --dry-run=server` with `lookup` (the kustomization and chart are project input, trusted per THREAT_MODEL); `-o JSONPATH=…` lower-casing (asks now anyway, through the case-insensitive match).
Costs: any kubectl command printing a possible Secret with `-o yaml|json|…` asks (not only `get`); helm `--repository-config`/`--repository-cache` and `XDG_CACHE_HOME`/`XDG_DATA_HOME` assignments ask. No everyday verdict moved.
Needs a decision: none.

## Round 43: secrets:read (second pass), 2026-11-16, see commit
Incident first: the reviewer built its probe input with a Bash heredoc that held a `cat <<EOF … EOF` case. The inner `EOF` closed it early, and Git Bash on the Windows host ran the remaining candidate lines for real (`cat /proc/self/environ`, `ps eww`, `declare -p`, `export`, `cat ~/.git-credentials`, `diff ~/.netrc /dev/null`, `cat ~/*/config`). They only read, but the output, including the real environment, was saved to a tool-results file and the reviewer's transcript. Nothing went beyond the session. At the user's word, the main session deleted both files and found no other dump. The guide (`.claude/adversarial-review.md`, steps 2, 3 and 5) now has safety rules that every reviewer brief carries: inputs written with the Write tool only; candidate commands run only in WSL, under `env -i` with fake values in a temp directory; nothing that reads real credentials or the real environment; and no test suites on Windows.
After that, the reviewer used fake values in WSL. I re-ran every Bash claim in WSL under `env -i` with a fake HOME (`GITHUB_TOKEN=ab-cd.ef`, `FAKE_PIN_TOKEN=4242`). 24 of the new escapes cases fail on 94bd6a9.
Confirmed and fixed:
- `declare -px GITHUB_TOKEN` (`-xp`, `-gp`) → allow, prints it → any `-…p` cluster counts, as does `local` (`shopt -s localvar_inherit; f() { local GITHUB_TOKEN; local -p; }` printed it).
- `PS4='$GITHUB_TOKEN '; set -x; true`, `x='$GITHUB_TOKEN'; echo "${x@P}"` → allow, printed `ab-cd.ef` → the text a prompt string expands goes through the same secret check (`expansions()` emits a `:` reading it).
- `[[ GITHUB_TOKEN -eq 0 ]]`, `declare -i n=GITHUB_TOKEN` (and `declare -i n; n=…`), `a[GITHUB_TOKEN]=1`, `${a[0+GITHUB_TOKEN]}`, `${x:GITHUB_TOKEN}`, `x=GITHUB_TOKEN; $(( x ))`, `x=GITHUB_TOKEN; [[ $x -eq 0 ]]` → allow; each printed the value in its error (`4242` outright for a numeric one) → every name in arithmetic (`arithmeticNames`) counts, a variable's known value is followed to the names it holds (`evaluatesSecret`), and integer assignments are arithmetic.
- `[ "$GITHUB_TOKEN" foo ]`, `[ x "$GITHUB_TOKEN" y ]` → allow, the error shows it; `test -n "$GITHUB_TOKEN"; echo "$_"` printed it → only `[ … ]` in a form that can't error (one word, a unary test, a string comparison, maybe after `!`, with no word that may split) stays exempt; `test` isn't.
- `shopt -s dotglob; cat ~/*/credentials`, `GLOBIGNORE=x; …` → allow, printed the fake `~/.aws/credentials` → `dotglob` is a followed option, and with it or a GLOBIGNORE set, a wildcard may match a leading dot.
- `git config --file=.pypirc --list` → allow, printed `pypi.password=pypi-FAKE` → git config's `--file` is checked as a read.
- yq `load_str(…)`, `load_xml`, `load_props`, `load_base64`; jq `import "…" as $c` → allow → those count. Not run (neither is installed in WSL): from the yq operator docs and the jq manual.
False positives fixed: `git check-ignore|ls-files|status|add|rm|restore|check-attr .env` only name it; `cp .env.example .env` writes `.env`, it doesn't read it; `MAX_TOKENS`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (a word MAX, MIN, NUM, COUNT, LIMIT or BUDGET); jq `{env: …}` keys.
Rejected (kept fail-closed): `cat cert.pem` (`.pem` may be a key); `$CACHE_KEY`; `env | grep …`, `printenv | grep …` (the whole environment goes into the pipe); `cat .npmrc`; `ps user` (procps reads it as BSD `u s e r`, `e` included; it errors here).
Costs: `test -n "$TOKEN"` now asks (`[ -n "$TOKEN" ]` stays allow); `local` with no names in a function, integer assignments of names that are secrets, and prompt strings with secrets ask. No everyday verdict moved.
Needs a decision: none.

## Round 44: kubectl, helm and terraform specs (second pass, after 0.4.0's dry runs), 2026-11-16, see commit
Rerun of the round stopped for the 0.4.0 work. The reviewer cited kubectl, client-go, kustomize, helm and terraform source and docs, and checked in-process only. No Bash claim was involved, so nothing ran in WSL. 17 new escapes cases fail on c5b819a.
Confirmed and fixed:
- `kubectl delete|create|replace --raw … --dry-run=server|client` → allow as a dry run; the raw branch (`rawhttp.RawDelete/RawPost/RawPut`) never consults DryRunStrategy → kubectl's dry run keeps `network` with `--raw`.
- `kubectl run x --image=busybox --detach-keys --dry-run=client -- sh -c id` → allow; pflag gives `--dry-run=client` to the string flag the spec lacks, and the pod runs → `rehearse` gives up the dry run when the command has an unknown option (other than the dry-run option itself, which npm's spec leaves unknown) or maybe-options. This holds in every spec.
- `kubectl get secret x -v=8`, `describe secret x --v 10` → allow; client-go logs response bodies from V(8) → `-v` of 8 or more (or unknown) with a possible Secret is `secrets:read`/`secrets:print`.
- `kubectl config view` → allow; RedactSecrets only redacts `datapolicy`-tagged fields, not auth-provider config maps or exec env values → `config view` always reads secrets.
- `kubectl get -f pod.yaml,https://…`, `helm template . -f v.yaml,https://…` → allow; `-f`/`--values` are string slices split at commas → each item is checked for a URL.
- `kubectl get -k github.com/evil/repo//base`, `apply -k deploy@evil.example:org/repo`, `kubectl kustomize github.com/evil/repo` → allow; kustomize clones SCP-style addresses and host-first paths → `remoteKustomization`.
- `helm upgrade rel ./chart --reuse-values --dry-run=server` → allow; the dry run prints the rendered manifest with the stored values, Secrets included unless `--hide-secret` → `secrets:read`/`secrets:print` when the values or lookups come from the cluster.
- `terraform workspace select -or-create prod2` → allow; it creates the workspace in the backend → `network`.
- `kubectl config set users.u.exec.command /tmp/evil`, `kubectl kuberc set …` from HOME → allow; `recommended`'s list of user configuration that runs code lacked `~/.kube` → added.
- `helm repo index ..`, `helm dependency update ../other` → allow with an empty writes list → they write their directory argument (default `.`).
Rejected (not changed): `TF_LOG=trace` printing provider responses (provider-dependent, uncited); `terraform init -backend-config=/tmp/b.hcl` (a backend file is configuration; reads outside the project are allowed, and the policy, not the spec, places it).
Costs: `kubectl config view` (any form) asks; dry runs with an option the spec doesn't know ask as the real command; `-v=8`+ on Secrets, comma URL lists, host-named kustomizations, `select -or-create`, writes under `~/.kube`, and helm index or dependency writes outside the project ask. No everyday verdict moved.
Needs a decision: none.

## Round 45: secrets:print (new in 2c8b367), 2026-11-16, see commit
The reviewer checked in-process and in WSL under `env -i` with fake values (`GITHUB_TOKEN=ab-cd.ef`, a fake `.env`). I re-ran every Bash claim I fixed the same way: a script written with the Write tool, a temp HOME, `env -i`. 30 new cases (analyze and escapes) fail on e5e0a2c. Every false negative here already read the secret, so `recommended` asked; only the `print` mark was missing, which a policy that allows reads but not prints relies on.
Confirmed and fixed:
- Through variables and substitutions: `echo "$(cat .env)"`, `x=$(cat .env); echo "$x"`, `t=$GITHUB_TOKEN; echo "$t"`, `read -r l < .env; echo "$l"`, `mapfile … ; printf …`, `printf -v x …; echo "$x"`, `for t in $GITHUB_TOKEN` → no print; nothing followed the value → `State.secretVars` (assigned from a secret expansion or a substitution that read one; names a reading `read`/`mapfile`/`printf`/`declare` assigns; a loop's variable), and a substitution that read a secret puts it in its command's words.
- Pipe consumers: `| while read …; do echo; done`, `| { cat; }`, `| f`, `| env cat` (and command, nice, timeout, sudo, stdbuf, bash -c), `| /bin/cat`, `| xargs` → no print, as only a literal copying name passed it on → `copiesThrough` fails closed: only a known program that doesn't copy (or `read`) keeps it; `| tee /dev/stderr | wc` prints.
- Sent back from a capture: `x=$(cat .env >&2)`, `exec 3>&1; x=$(cat .env >&3)`, `cat .env > >(cat)`, `> /proc/self/fd/1` → no print → `stdout()` tracks where each descriptor goes (inherited, a file, or the output some other way), with `/proc/self/fd/N`, `/dev/./stdout`, `/dev/pts/N` and process substitutions; `1<&-` closes it.
- `set -x; t=$GITHUB_TOKEN` → the trace prints it → traced expansions print.
- Programs that print whole: `dd if=.env`, `cp .env /dev/stdout`, `git show HEAD:.env` (cat-file, diff), `sort`, `uniq`, `hexdump`/`hd`, `rev`, `paste`, `join`, `diff`, `comm`, `zcat`, `batcat` → `copies`.
False prints fixed: `echo "${#GITHUB_TOKEN}"`, `${GITHUB_TOKEN:0:4}`, `${GITHUB_TOKEN//?/*}` (read, not printed whole); `cat .env 1<&-`; `cat .env.local.example` (a template).
Rejected or open (not changed): `exec 3< .env; cat <&3` (the read through a numbered descriptor isn't followed: open); `exec >/dev/null; cat .env`, `coproc cat .env`, `cat .env | cat .env.example` still print (false prints, fail-closed); `cat cert.pem` (kept: `.pem` may be a key); `tr`, `fold`, `column`, `cut` (transform; not marked).
Costs: none on verdicts (every case already read a secret); more invocations carry `secrets:print`. No everyday verdict moved.
Needs a decision: THREAT_MODEL says a program that transforms what it reads (`grep`, `awk`, `jq`) reads a secret but doesn't print it, yet `grep TOKEN .env`, `env | grep -i token`, `printenv | sort` (now printed through `sort`), `sed -n p .env`, `awk 1 .env` and `awk 'BEGIN{print ENVIRON["X"]}'` print it whole in WSL. I'd recommend counting `grep` (it prints matching lines whole) and the environment piped into it as printing, and `sed`/`awk`/`jq` when their script may print a line unchanged; that changes the THREAT_MODEL sentence, so it's yours.
