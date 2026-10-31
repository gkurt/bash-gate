---
packages:
  'bash-gate': minor
---

### First release

Static analysis of Bash command lines for agent permission gates: `analyze` lists every program a command line can run, with its options, paths and effects, and `check` decides it under a policy of allow, ask and deny rules.

### The analysis

Variables, functions, aliases, loops, `cd`, wrappers (`env`, `xargs`, `sudo`, `timeout`, …), `bash -c`, `eval`, traps and code inside strings are followed as Bash runs them. Anything it can't follow becomes a dynamic argument or a finding, never a gap. Program specs read options the way each program does, including subcommands and options that run code (`git -c`, `find -exec`, `sed e`, `tar --to-command`, `ssh -o ProxyCommand`).

### Policies

Rules match commands, options, paths (as written, resolved, under `~`, and real paths through an optional `realpath`) and effects. A rule that only may match never allows. `recommended` allows reading and everyday git, denies force pushes and deleting top-level directories, and asks about the rest.

### Repository code

An optional `readFile` hook walks Git config and its includes, Git hooks, `ssh -F` config and npm lifecycle scripts as code. `THREAT_MODEL.md` states the promises and which tests check each, including runs against real Bash.
