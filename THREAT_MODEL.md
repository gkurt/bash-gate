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
default shell options. Everything the shell knows comes from the command itself. When the integration can't
guarantee this, the gate's answers are about some other shell.

The integration may provide `fs`, the filesystem as it is before the command runs: `readFile(path)` to inspect
repository-controlled configuration and scripts, and `realpath(path)` to resolve paths. Each answers `null` when
nothing is there (for `realpath`, not even a dangling symlink) and `undefined` when it doesn't know. They are
synchronous, use `/`-separated paths, and callback errors propagate to the caller. An unknown answer is an
`unknown-file` finding, so it can't lead to an allow; `checkAsync` fetches unknown answers from an asynchronous
filesystem and analyses again. Without `fs`, the limits below apply.

The answers describe the filesystem before the command, which the command may change. A file the script may write
before it's read, or while it's read (code that runs alongside: `&`, a pipeline, `<(…)`, `coproc`), is unknown, and
so is the real path of anything under a path where the script may create a symlink. A write may land elsewhere
through a symlink that's already there, so writes count at their real path too, and without an absolute `cwd` any
write makes later reads unknown. The writes counted are those of redirections and specs, plus the work tree (all but
its `.git`) of a git command that rewrites it. A program that may write files no one can name (no spec, code the
analysis doesn't follow, or a spec that writes without saying where) makes every later read and real path unknown.

Nothing else changes the filesystem between the analysis and the end of the run. That rules out a process an earlier
command left running: a job from an allowed `make &`, `nohup` or `setsid -f` could rewrite `.git/config` or a hook
after the next command was analysed, and that command's git would run it. The integration runs commands one at a
time, and each ends only once everything it started has exited or been killed. `bash-gate/trace` does that itself:
`run` resolves once every process in the tree has exited, daemons included, and `timeout` or the supervisor's own exit
kills what's left.

Out of scope:

- **What programs do with their input.** `cat` reading a file, a compiler running build scripts, and file-based
  configuration when no `fs` is supplied. With it, repository Git config (and includes), Git hooks, SSH config passed
  with `-F`, and npm lifecycle scripts are followed. gh's stored aliases and config are never read: a first word gh
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
shell runs from strings (`eval`, `trap`, `bash -c`, aliases, git config) counts. A construct the analysis can't follow
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
wrappers, `eval`, `bash -c`, functions, aliases, `hash -p`. A rewrite that hides a value from static analysis (a
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
given, as S1 defines it, or fails with EPERM before the program runs. So does one from a process with several
threads, whose arguments could change after the check, and one whose arguments can't be read. What a program the
analysis doesn't follow inside starts (`git`, `make`, a script file) isn't checked: that's its behaviour, out of scope
above. The supervisor checks execs only: a builtin's write needs none. Under it no exec gains privileges
(`no_new_privs`), no process holds `CAP_SYS_PTRACE` (root included), i386 execs kill the process, and so does any x32
system call.

## What is trusted

- **[unbash](https://github.com/webpro-nl/unbash) 6.0.3 parsing like Bash 5.3.** A parser that disagrees with Bash is
  the classic bypass, so S1 is tested against Bash itself, not against the parser.
- **The specs.** A wrong spec, such as a missed option that takes a value or runs code, breaks S1 for that program.
- **The integration.** It must run exactly the string that was analysed, in the shell the assumptions describe, with
  nothing from an earlier command still running. `bash-gate/trace` does that itself, given the analysis that was
  checked.
- **For S6, the kernel and the supervisor.** ptrace and seccomp stop every `execve` and `execveat` (x86_64 Linux). The
  supervisor reads an exec's arguments before the kernel does, so a process that writes another's memory in between
  (`/proc/<pid>/mem`, `process_vm_writev`) can change what an allowed exec runs. With Yama's `ptrace_scope` at 1 or
  more (Ubuntu's default), and no `CAP_SYS_PTRACE` in the tree, a process can write only its descendants' memory.
  Every process above a checked one is a shell or wrapper the analysis follows, so only a program one of those became
  with `exec` while checked children of it still run (`ls & exec python3 x`) can. With `ptrace_scope` 0, or without
  Yama, any program in the tree the analysis doesn't follow can.

## How each promise is checked

| Promise | Check                                                                               | Where                      |
| ------- | ----------------------------------------------------------------------------------- | -------------------------- |
| S1      | Scripts run in real Bash with logging stubs: everything that ran must be covered    | `test/bash.test.ts`        |
| S1      | The same, for generated scripts mixing the constructs the analysis follows          | `test/bash.test.ts`        |
| S1      | Known escapes, one per construct                                                    | `test/escapes.test.ts`     |
| S1      | The hand-written scripts with real programs: every exec the kernel sees is covered  | `test/trace.test.ts`       |
| S1      | The same, for the generated scripts                                                 | `test/trace.test.ts`       |
| S1      | With a filesystem: what the script writes before or alongside a read is unknown     | `test/analyze.test.ts`     |
| S2      | Property tests over generated invocations and policies                              | `test/properties.test.ts`  |
| S3      | Property tests: generated commands with findings or maybe-matches are never allowed | `test/properties.test.ts`  |
| S4      | Metamorphic tests: chains of generated rewrites of denied and asked commands        | `test/metamorphic.test.ts` |
| S5      | Property tests: arbitrary token soup never throws                                   | `test/properties.test.ts`  |
| S5      | Deeply nested loops stay cheap and below the budget                                 | `test/analyze.test.ts`     |
| S5      | Exhaustive `switch`es with a fail-closed `default`                                  | `src/analyze.ts`           |
| S6      | Execs the analysis didn't predict are refused, from the shell and from wrappers     | `test/trace.test.ts`       |
| S6      | No process holds `CAP_SYS_PTRACE`, as root too; one can't write its parent's memory | `test/trace.test.ts`       |

Still to come: an LLM red team judged by `trace` mode, and the supervisor on arm64.
