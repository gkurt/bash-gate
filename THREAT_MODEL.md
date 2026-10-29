# Threat model

What shell-gate promises, under which assumptions, and how each promise is checked. A change that weakens one of
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

Out of scope:

- **What programs do with their input.** `cat` reading a file, a compiler running build scripts, git reading the
  repository's `.git/config`. Specs say what's known about a program's arguments (`git -c`, `find -exec`). A program
  without a spec, or whose behaviour depends on files, is only as safe as the policy that allows it.
- **What the filesystem holds.** Globs, symlinks, which files exist, `$HOME`.
- **Other shells.** zsh, fish, PowerShell, cmd.exe.
- **Timing and resources.** Fork bombs and `sleep 1e9` are effects of allowed programs.

## What is promised

**S1. The analysis over-approximates execution.** For every command line `c`, and every run of `c` in a clean Bash,
every process the shell starts, with its program and argv, is *covered* by an invocation in `analyze(c)`. Covered
means the same program, with each static argument equal and each dynamic argument standing for any words. Code the
shell runs from strings (`eval`, `trap`, `bash -c`, aliases, git config) counts. A construct the analysis can't follow
must become a finding, or a dynamic argument, command, option or `open` invocation. It must never disappear.

**S2. The policy is monotone in what it's unsure of.** Making an invocation more capable never lowers its decision
under `strict: true`. That means adding an option, positional, write or effect, making a static argument dynamic,
making the program dynamic, setting `maybeOptions` or `open`, or giving the program a non-system path. Without
`strict`, it may lower `deny` to `ask` (a rule that only may match asks), but never to `allow`. Conditions on allow
rules hold for *all* of an invocation's paths and effects; on deny and ask rules, for *any*.

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

**S5. Fail closed.** No input makes the analysis or the policy throw. A syntax node the analysis doesn't know (a
newer parser) becomes a finding. The parser version is pinned.

## What is trusted

- **[unbash](https://github.com/webpro-nl/unbash) 6.0.1 parsing like Bash 5.3.** A parser that disagrees with Bash is
  the classic bypass, so S1 is tested against Bash itself, not against the parser.
- **The specs.** A wrong spec, such as a missed option that takes a value or runs code, breaks S1 for that program.
- **The integration.** It must run exactly the string that was analysed, in the shell the assumptions describe.

## How each promise is checked

| Promise | Check | Where |
| --- | --- | --- |
| S1 | Scripts run in real Bash with logging stubs: everything that ran must be covered | `test/bash.test.ts` |
| S1 | Known escapes, one per construct | `test/escapes.test.ts` |
| S2 | Property tests over generated invocations and policies | `test/properties.test.ts` |
| S3 | Property tests: generated commands with findings or maybe-matches are never allowed | `test/properties.test.ts` |
| S4 | Metamorphic tests: chains of generated rewrites of denied and asked commands | `test/metamorphic.test.ts` |
| S5 | Property tests: arbitrary token soup never throws | `test/properties.test.ts` |
| S5 | Exhaustive `switch`es with a fail-closed `default` | `src/analyze.ts` |

Still to come: differential fuzzing in a Linux container with `strace` as the oracle, an LLM red team judged by that
oracle, and enforcement at exec time so that a gap in S1 is a refused command rather than an escape.
