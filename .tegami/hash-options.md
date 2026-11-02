---
packages:
  'bash-gate': patch
---

### `hash` reads its options as Bash does

They end at the first name (`hash x -p /bin/true rm` gives `rm` no path), `-p` gives its path to every name, and a
name without `-p` is looked up on `PATH` again, forgetting the path it had. A name only known at run time is a
finding.
