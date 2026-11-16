# Adversarial review round

You are running one round of a self-paced loop that hardens bash-gate. Each round: find bypasses, prove them, fix them,
commit, log. Follow AGENTS.md throughout. The goal is soundness: a library the harness can trust. Never suggest a
release, and never push.

## 1. Pick the area

Read `.claude/adversarial-log.md` (create it if missing). Take the next area in this rotation that the log's last rounds
haven't just covered:

1. `src/words.ts`: quoting, expansions, field splitting, globbing, brace expansion, here-docs.
2. `src/analyze.ts` shell state: variables, namerefs, functions, aliases, `hash`, `enable`, `cd`, traps, `source`.
3. `src/analyze.ts` dispatch and wrappers: `env`, `sudo`, `xargs`, `find -exec`, `timeout`, `nice`, `command`, `exec`, code
   inside strings (`bash -c`, `eval`, `PROMPT_COMMAND`-like hooks).
4. `src/argv.ts`: option parsing, attached values, abbreviations, `--`, cobra's rules, subcommands.
5. `src/specs.ts`: program specs and git's config keys that run code. Check a spec against the program's real docs.
6. Files and project code: `src/files.ts`, `src/paths.ts`, `src/husky.ts`, package scripts, what a script writes before
   it reads, symlinks, `exec:project` bounds.
7. `src/policy.ts` and `src/recommended.ts`: three-valued matching, how rules combine, what `recommended` allows.
8. `src/trace/` and `src/cover.ts`: whether the analysis covers what the kernel sees.

## 2. Review it fresh

Spawn one reviewer subagent with no context from earlier rounds. Give it the area's files, `THREAT_MODEL.md`, and this
brief: find concrete commands whose verdict under `recommended` is `allow` (or whose effects are missing something),
but which in real Bash run, write, fetch or delete something the analysis doesn't report. It must give each finding as a
command, the environment (`cwd`, `fs` contents) and what really happens. Don't pass on your own suspicions or earlier
findings. You want a read that isn't anchored on yours.

Pass it the safety rules below word for word. In round 43, a reviewer's Bash heredoc closed early on an inner `EOF`,
and Git Bash on the Windows host ran its candidate commands for real, printing the real environment and credentials
files into a saved tool result.

**Safety rules, for the reviewer and for you while confirming:**

- Write test inputs (case lists, scripts) only with the Write tool, never with a Bash heredoc or `echo` into a file.
- Run a candidate command only inside WSL, never on the Windows host: in a fresh temp directory (`mktemp -d`), under an
  environment emptied with `env -i` and given fake values only (`env -i HOME="$d" PATH=/usr/bin:/bin
  FAKE_TOKEN=ab-cd.ef bash script.sh`).
- Never run anything that reads real credentials or the real environment, even in WSL: `printenv`, `env`, `cat ~/…`,
  `ps e`, `declare -p` and the like are tested only on fake files under the temp `HOME` and fake variables.
- Don't run test suites or process loops on Windows: the Git Bash suite spawns thousands of processes. Run
  `test/bash.test.ts`, `test/trace.test.ts` and `bun run checks` only in WSL (`~/bg`). On Windows, use small in-process
  Bun scripts that call the analysis.

## 3. Confirm each finding

A finding is real only when both of these hold:

- A failing test reproduces it: a case in `test/escapes.test.ts`, or in `test/analyze.test.ts` when it needs an `fs`.
- What it claims about Bash is true. Check it in real Bash with harmless commands (`echo`) under WSL, following the
  safety rules in step 2: a script written with the Write tool, run under `env -i` with fake values in a temp
  directory. The repo copy is `~/bg`; sync `src` and `test` to it first.

Drop the rest, and log them as rejected with the reason.

## 4. Fix

- Fail closed: what can't be followed becomes dynamic, `open`, `maybeOptions` or a finding. It never disappears.
- A construct that changes what runs also gets a script in `test/scripts.ts`.
- Keep `unbash` pinned. Use no `Bun.*` in `src`. Use LF line endings.
- Update README.md, THREAT_MODEL.md, AGENTS.md and `site/` when behaviour they describe changes. Add or update a
  `.tegami/<slug>.md` entry (see the `changelog` skill). If an entry for unreleased work already covers the area,
  update it in place. Start its body with a `### ` heading: Tegami silently leaves out an entry without one.

### What you must not decide alone

- **`test/everyday.test.ts`** pins what everyday commands get. If a fix changes any line there, don't commit the fix.
  Log it under "Needs a decision" with the command, its old and new verdict and why, and revert it.
- **Trust boundaries.** A fix that would change a promise in `THREAT_MODEL.md` (S1–S5, what counts as project code,
  what is trusted) is not yours to make. Examples: trusting less of the work tree, or asking about `exec:project`.
  Log it under "Needs a decision" and leave the code as it is.
- **A finding the fix makes asking more broadly.** If the fix makes more than the finding's own commands ask, list the
  newly asking commands in the log's "Costs" for that round.

## 5. Check and commit

On Windows, run `bun run fix`, `bun check`, `bun typecheck` and the in-process test files (`bun test
test/analyze.test.ts test/escapes.test.ts test/everyday.test.ts test/match.test.ts test/metamorphic.test.ts
test/properties.test.ts`), never `bun run checks` or `test/bash.test.ts`. Run the whole suite in WSL after syncing
`src` and `test` to `~/bg`:

```
MSYS_NO_PATHCONV=1 wsl.exe -e bash -lc 'cd ~/bg && PATH=$HOME/.bun/bin:$PATH bun test'
```

All must pass. Commit to the current branch (`main`) with one commit per round. Stage only the files you changed, with
the round's entry in `.claude/adversarial-log.md` (write it, step 6, before committing); nothing else under `.claude/`.
Write a subject line that says what is now caught. Don't create or switch branches, and don't push.

## 6. Log

Append to `.claude/adversarial-log.md`:

```
## Round N: <area>, <date>, <commit or "no commit">
Confirmed and fixed: <command> → <what was wrong> → <fix>
Rejected: <claim> → <why>
Costs: <commands that now ask that didn't>
Needs a decision: <item, with what you'd recommend>
```

## 7. Pace and stop

- If the round confirmed nothing, note it. **Stop the loop** after two rounds in a row confirm nothing, or after 12
  rounds in all. Leave a final summary in the log when you stop.
- Otherwise, schedule the next round soon (60–120 s).
- If "Needs a decision" holds items, keep going in other areas. Don't wait on them.
