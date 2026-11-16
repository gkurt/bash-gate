# Threat model

What bash-gate promises, under which assumptions, and how each promise is checked. A change that weakens one of
these needs a reason written here.

## The setting

An agent proposes a Bash command line. The gate decides before it runs: `allow` runs it, `ask` shows it to a person,
`deny` refuses it. The agent may be adversarial: it may write commands designed to get a forbidden effect past the
gate, and it can read this repository.

## Assumptions

The command runs in a **clean Bash**: `bash --noprofile --norc -c '<command>'` with a fixed environment (`env -i` plus
known variables), no `BASH_ENV` or `ENV`, a `PATH` of system directories only, no inherited functions or aliases, and
default shell options (no BASHOPTS or SHELLOPTS in the environment). Everything the shell knows comes from the command
itself, options included: those it turns on are followed, or a finding when what they change isn't. When the integration can't
guarantee this, the gate's answers are about some other shell.

The integration may provide `fs`, the filesystem as it is before the command runs: `readFile(path)` to inspect
repository-controlled configuration and scripts, and `realpath(path)` to resolve paths. Each answers `null` when
nothing is there (for `realpath`, not even a dangling symlink) and `undefined` when it doesn't know. They are
synchronous, use `/`-separated paths, and callback errors propagate to the caller. An unknown answer is an
`unknown-file` finding, so it can't lead to an allow; `checkAsync` fetches unknown answers from an asynchronous
filesystem and analyses again. Without `fs`, the limits below apply.

The answers describe the filesystem before the command, which the command may change. A file the script may write
before it's read, or while it's read (code that runs alongside: the other commands of a pipeline, and with `&`,
`<(…)` or `coproc` the rest of the script), is unknown, and
so is the real path of anything under a path where the script may create a symlink. A write may land elsewhere
through a symlink that's already there, so writes count at their real path too (a `..` after a symlink leads up from
where it points, as the kernel has it), and without an absolute `cwd` any
write makes later reads unknown. The writes counted are those of redirections and specs, plus the work tree (all but
its `.git`) of a git command that rewrites it. A program that may write files no one can name (no spec, code the
analysis doesn't follow, or a spec that writes without saying where) makes every later read and real path unknown.
When only project code (`exec:project`) may have written it, a read is a `project-file` finding rather than
`unknown-file`, what was there before is still walked, and real paths are kept: a policy that allows project code to run (as `recommended` does, and allows
`project-file`) already lets it write anything, a hook or a symlink included. A policy that asks about `exec:project`
asks about the code itself. A git command that rewrites the work tree may bring in anything: another branch or commit,
a merge, a rebase or a patch anything anyone pushed, and even `HEAD`, the index or a stash (`git checkout -- f`, `reset
--hard`, `stash pop`) what an earlier command, or this one, committed, staged or stashed. So a read after it is
unknown, and so are the real paths in it, since a commit may hold a symlink to anywhere. So is what `tsc` copies into its
output (the JSON its sources import, from wherever they are).

Project code is the code of the project where the script starts (`cwd`), at its real path. Run from anywhere else (`cd .. && npm test`,
`npm --prefix /tmp/x test`, `git -C /tmp/x commit`, and git with any command there: its config may run code), or given files from elsewhere to run or to find configuration
beside (`bun test /tmp/x.test.ts`, `eslint ../other`), it's `exec:file`; so is project code run under a symlink the
script may have put there, or under a work tree git rewrote. The words after a package script's name are appended to
it: they're walked with it, and without `fs` they make it `exec:arbitrary`. What the project holds is its own, whoever
put it there: code the analysis doesn't read (a `build.rs`, a `vitest.config.ts`) is trusted as it is when it runs,
including what the script writes or copies into the project before (`cp /tmp/x.test.ts . && bun test`). A policy
for which that matters asks about `exec:project`.

Nothing else changes the filesystem between the analysis and the end of the run. That rules out a process an earlier
command left running: a job from an allowed `make &`, `nohup` or `setsid -f` could rewrite `.git/config` or a hook
after the next command was analysed, and that command's git would run it. The integration runs commands one at a
time, and each ends only once everything it started has exited or been killed. `bash-gate/trace` does that itself:
`run` resolves once every process in the tree has exited, daemons included, and `timeout` or the supervisor's own exit
kills what's left.

Out of scope:

- **What programs do with their input.** `cat` reading a file, a compiler running build scripts, and file-based
  configuration when no `fs` is supplied. With it, repository Git config (and includes), Git hooks, SSH config passed
  with `-F`, and the package.json scripts npm, pnpm and bun run are followed. The repository is the one git takes: what `--git-dir` or `--bare`
  names, else the first from the working directory up (both the shell's path and where it really is, as git uses
  `getcwd`), a `.git` or the directory itself, that has a `HEAD` and the directories `objects` and `refs`. One that may
  lack them is followed, and so are those above it. A `.git` file and `commondir` are read as git reads them, a `..`
  after a symlink leading up from its target; config is parsed as git parses it, with a finding where git would refuse
  it. The submodules `.gitmodules` names are followed too, and theirs in turn; a nested repository it doesn't name is not. The hooks followed are the ones the
  command runs in git 2.55, plus `pre-auto-gc` where older gits collect garbage afterwards; a command the table
  doesn't have may run any. They're read from `core.hooksPath` where that directory is certain, and from the config's
  own `hook.<name>.command`. A hook is read as the shell its first line names (`sh`, which expands aliases, with
  none): a system shell with no options but `set`'s, or one `env` names; anything else, another language included, is
  a finding. Hooks are read again once a command's hooks have all run, since one may write another git runs later. Package scripts are read as `sh` runs them, and so is code other programs
  hand to `sh` (`watch`, `git rebase -x`): as Bash in POSIX mode, with a finding for Bash's own syntax, which dash
  reads otherwise (`&>`, `((`, `$'…'`, `[[`, brace expansion) and for builtins dash doesn't have (`declare`, `shopt`,
  `source`), which it skips. The user's and the system's git config are never read, nor husky's
  user files (`~/.config/husky/init.sh`, `~/.huskyrc`). Hooks husky wrote are followed to the project's own hook in
  `.husky`, only when their text is exactly what husky 7, 8 or 9 writes; under a hooks path ending in `.` or `..`, where
  husky's dispatcher finds another hook than the folded path, they're a finding. gh's stored aliases and config are never read: a first word gh
  doesn't know is code unseen (`exec:arbitrary`), and its pager, editor and browser are what they were. Specs describe other known argument behavior, writes included: a
  specified program that writes a file its spec doesn't name can change what a later read sees.
- **What the filesystem holds.** Globs and which files exist. `$HOME` too, unless the script sets it or the integration
  passes it in `env`. Symlink targets are considered only when `fs` is supplied and the invocation's `cwd` is
  absolute. Deny and ask rules match any path form; allow rules must match the resolved real path as well. Relative
  globs match from the starting `cwd` when it's given as an absolute path; when it isn't, an absolute path may match
  them.
- **Other shells.** zsh, fish, PowerShell, cmd.exe. Their code run from Bash (`zsh -c`) is never parsed as Bash: it
  counts as code the analysis can't see into.
- **Timing and resources.** Fork bombs and `sleep 1e9` are effects of allowed programs.

## What is promised

**S1. The analysis over-approximates execution.** For every command line `c`, and every run of `c` in a clean Bash,
every process the shell starts, with its program and argv, is _covered_ by an invocation in `analyze(c)`. Covered
means the same program, with each static argument equal and each dynamic argument standing for any words. Code the
shell runs from strings (`eval`, `trap`, `bash -c`, a shell's here-document, aliases, git config, the history, a prompt
string, a subscript in a name a builtin reads or in a value evaluated as arithmetic) counts,
and so does `command_not_found_handle`, which Bash runs for a command it can't find. A construct the analysis can't follow
must become a finding, or a dynamic argument, command, option or `open` invocation. It must never disappear.

**S2. The policy is monotone in what it's unsure of.** Making an invocation more capable never lowers its decision
under `strict: true`. That means adding an option, positional, write or effect, making a static argument dynamic,
making the program dynamic, setting `maybeOptions` or `open`, or giving the program a non-system path. Without
`strict`, it may lower `deny` to `ask` (a rule that only may match asks), but never to `allow`. Conditions on allow
rules hold for _all_ of an invocation's paths and effects (including the real path when provided); on deny and ask
rules, for _any_ path form.

**S3. Allow is earned.** A command line is allowed only when every finding is one the policy allows (none by
default), and every invocation is allowed with no deny or ask rule even possibly matching it. An invocation is allowed
by an allow rule that certainly matches, or by `default: 'allow'` when the policy chooses that. A parse error
anywhere, nested code included, is a finding.

**S4. Rewrites don't change the decision.** If two command lines run the same processes in a clean Bash, they're
decided the same way, or the rewrite is decided more strictly. Examples: quoting, escapes, braces, variables,
wrappers, `eval`, `bash -c`, functions, aliases, `hash -p`, `BASH_ALIASES`, `BASH_CMDS`, namerefs. A rewrite that hides a value from static analysis (a
substitution, an unset variable, or exceeding the analysis depth limit) may turn `deny` into `ask`, never into
`allow` under the default finding decisions. The depth limit necessarily loses information even when the code is
literal; a `too-deep` finding asks by default. S1 and S2 support S4 but don't by themselves guarantee that a
finding retains a known denial, so S4 is also tested directly where bypasses show up.

**S5. Fail closed.** No shell input makes the analysis or the policy throw, or run without bound: past a work budget,
the walk stops with a `too-deep` finding. A syntax node the analysis doesn't know (a newer parser) becomes a finding.
The parser version is pinned. Errors thrown by caller-supplied filesystem callbacks propagate to the caller.

**S6. Under enforcement, an exec the analysis doesn't cover doesn't run.** With `bash-gate/trace` in `enforce` mode,
every exec the shell makes, or a wrapper it follows makes (`env`, `xargs`, `find -exec`: a program without
subcommands that the analysis predicts commands under, run on this machine), either is covered by the analysis it was
given, as S1 defines it, or fails with EPERM before the program runs. Covered means the file run is the one predicted
(the path given, or one in a directory of the run's `PATH` for a name, a relative path from where the process really
is; never a path with `..` after a name or under `/proc`, which the kernel reads through symlinks), and so is the name it's started under (its `argv[0]`, which `exec -a` sets and some programs act on). The shell a
wrapper runs code through (`flock -c`, `watch`) is covered only from a system directory. So does one whose arguments can't be read. From
the moment an exec stops until the kernel has copied its arguments or failed it, every other process and thread in the
tree is stopped, so nothing in it can change what the exec runs after the check. What a program the analysis doesn't
follow inside starts (`git`, `make`, a script file) isn't checked: that's its behaviour, out of scope above. The
supervisor checks execs only: a builtin's write needs none. Under it no exec gains privileges (`no_new_privs`), no
process holds `CAP_SYS_PTRACE` (root included), no process leaves the tree (a clone with `CLONE_UNTRACED` fails), i386
execs kill the process, and so does any x32 system call.

## What is trusted

- **[unbash](https://github.com/webpro-nl/unbash) 6.0.3 parsing like Bash 5.3.** A parser that disagrees with Bash is
  the classic bypass, so S1 is tested against Bash itself, not against the parser, with scripts no generator would
  write too: mutants of the others, broken a few characters at a time. Builds of Bash disagree as well: Git Bash drops
  a carriage return from code it parses, where Bash on Linux and the parser keep it in a word, so one is a parse error.
- **The specs.** A wrong spec, such as a missed option that takes a value or runs code, breaks S1 for that program.
  The wrappers' specs are fuzzed against the real programs; the rest are checked by hand-written cases. `sed` and
  `awk` are on the recommended allowlist, so how their scripts are read is trusted too: a sed script only in the
  forms every sed reads alike, an awk program by the tokens it can't run a command or write a file without. So is
  `network:read`, which the recommended policy doesn't ask about: that `git fetch`, `git ls-remote` and gh's reading
  commands, given no URL, host or config of their own, call only the hosts the repository and gh were set up with, and
  that kubectl's and helm's reading commands, given no server, kubeconfig or chart URL of their own, reach only the
  cluster and repositories their config names. Checked against kubectl 1.35, Helm 3 and 4, and terraform 1.17 docs:
  which of their commands only read, which change a cluster or infrastructure, which run a plugin, and which print
  secrets (`secrets:read`). Which files and variables hold secrets is a list of names: one named otherwise isn't
  known to be one. A directory that holds one of them (`~/.ssh`, `~/.config`) is a secret read too, for a program that
  may read it recursively. `secrets:print` trusts that the programs a spec marks `copies` print what they read unchanged, and
  that output redirected to a file, piped into a program that doesn't copy it, or captured by a substitution doesn't
  reach the script's output; a secret printed by a program that transforms it (`grep`, `awk`, `jq`) is read, not
  printed. A dry run is lowered by its spec: that `--dry-run` (or `-n`) changes nothing a spec says it would, but for
  what the spec keeps (`gh pr create --dry-run` may push, `rsync -n` connects). A dry run's own effects, not
  `invocation.dryRun`'s, are what a policy matches. Where GNU
  coreutils and uutils (Ubuntu's since 25.10) read a wrapper's arguments differently, the command it runs is unknown,
  or, where each reading is known, both are walked (`env -- X=1 - cmd`).
  For npm, pnpm and bun, the specs say which of their own commands beat a script of the same name, which words they
  run as a script, a file or a command from PATH, and which of their options they know: the one they don't is
  configuration, `exec:arbitrary`. A flag that turns something off (`--ignore-scripts`, `--offline`) counts only
  given bare: npm reads `--ignore-scripts=false` as false. That cargo's builds and bun's runs fetch only from the
  registries and git hosts the project names (`network:read`). Checked against npm 11, pnpm 11 and bun 1.4. That `tsc` (TypeScript 7, whose
  configuration is JSON) writes only what it emits, and `biome` only the kinds of file it formats; and that a formatter
  keeps every value in a JSON file, so `biome` leaves a package.json's scripts as they were.
- **The integration.** It must run exactly the string that was analysed, in the shell the assumptions describe, with
  nothing from an earlier command still running. `bash-gate/trace` does that itself, given the analysis that was
  checked.
- **For S6, the kernel and the supervisor.** ptrace and seccomp stop every `execve` and `execveat` (x86_64 Linux), and
  ptrace stops the rest of the tree while one is checked. Paths mean what they mean outside the tree: a new user or
  mount namespace, `chroot`, `mount` and `setns` fail, so no process changes what a path names or gains capabilities. Memory the kernel writes on its own, rather than for a
  process it's running, can still change an exec's arguments after the check: asynchronous I/O (`io_uring`, AIO), and
  the words it clears or marks when a process that shares the memory dies (`set_tid_address`, robust futexes). Only a
  program running code of its own can arrange that, and such a program can already exec anything: what it starts
  isn't checked. So can a process outside the tree that may write the tree's memory: root's, or with Yama's
  `ptrace_scope` at 0, any of the same user's.

## How each promise is checked

| Promise | Check                                                                               | Where                      |
| ------- | ----------------------------------------------------------------------------------- | -------------------------- |
| S1      | Scripts run in real Bash with logging stubs: everything that ran must be covered    | `test/bash.test.ts`        |
| S1      | The same, for generated scripts mixing the constructs the analysis follows          | `test/bash.test.ts`        |
| S1      | The same, for mutants of both the parser accepts: a parser that disagrees with Bash | `test/bash.test.ts`        |
| S1      | The same runs: each program in the directory predicted, each file written predicted | `test/bash.test.ts`        |
| S1      | Real wrappers run nested: what each starts, under which, is what the spec predicts  | `test/bash.test.ts`        |
| S1      | Known escapes, one per construct                                                    | `test/escapes.test.ts`     |
| S1      | The hand-written scripts with real programs: every exec the kernel sees is covered  | `test/trace.test.ts`       |
| S1      | The same, for the generated scripts                                                 | `test/trace.test.ts`       |
| S1      | With a filesystem: what the script writes before or alongside a read is unknown     | `test/analyze.test.ts`     |
| S1      | With a filesystem: git's config is read from whichever directory git takes          | `test/analyze.test.ts`     |
| S1      | With a filesystem: each git command's hooks, from where `core.hooksPath` leads      | `test/analyze.test.ts`     |
| S2      | Property tests over generated invocations and policies                              | `test/properties.test.ts`  |
| S3      | Property tests: generated commands with findings or maybe-matches are never allowed | `test/properties.test.ts`  |
| S4      | Metamorphic tests: chains of generated rewrites of denied and asked commands        | `test/metamorphic.test.ts` |
| S5      | Property tests: arbitrary token soup never throws                                   | `test/properties.test.ts`  |
| S5      | Deeply nested loops stay cheap and below the budget                                 | `test/analyze.test.ts`     |
| S5      | Exhaustive `switch`es with a fail-closed `default`                                  | `src/analyze.ts`           |
| S6      | Execs the analysis didn't predict are refused, from the shell and from wrappers     | `test/trace.test.ts`       |
| S6      | An ancestor flipping a checked exec's path as fast as it can: what runs was checked | `test/trace.test.ts`       |
| S6      | No process holds `CAP_SYS_PTRACE`, as root too; one can't write its parent's memory | `test/trace.test.ts`       |
| S6      | A clone with `CLONE_UNTRACED` fails; threads, vfork and an exec from a thread run   | `test/trace.test.ts`       |

Still to come: an LLM red team judged by `trace` mode, and the supervisor on arm64.
