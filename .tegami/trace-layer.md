---
packages:
  'bash-gate': minor
---

### `bash-gate/trace` runs a command under a supervisor that checks every exec against the analysis

`run(source, { mode })` runs the command in Bash with every `execve` in its process tree stopped by ptrace and seccomp. In `enforce` mode, one the shell or a wrapper it follows (`xargs`, `env`, `find -exec`) makes that the analysis didn't predict fails with EPERM before it runs; in `trace` mode it runs and is reported. x86_64 Linux, Node, and a C compiler to build the supervisor on first use. The coverage check is in the main entry too, as `covers` and `predicting`.
