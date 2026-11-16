---
packages:
  'bash-gate': patch
---

### A program the analysis can't place covers only its own call

`covers` and `bash-gate/trace` treated every invocation that shared a `loads-code` finding's span as "any program, from anywhere". Code from a string (`bash -c`, `eval`, `trap`) and a wrapper's command share one span. So `bash -c '(exec -a k pgrep a); cat notes'` covered `rm notes`, and `hash -p "$P" find; find . -exec ls {} +` covered `rm -rf /` under `find`. Enforce mode would have run them.

That's now a field of the invocation itself: `Invocation.unplaced`. It covers that one call only. It's set for `exec -a`, a name `hash -p` gave a path only known at run time, and a git that runs a hook the analysis can't read.
