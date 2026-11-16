---
packages:
  'bash-gate': patch
---

### Writes to `/dev/stdin` and `/dev/fd/N`

Linux opens `/dev/stdin` and `/dev/fd/N` again as the file that descriptor is on, which may be one opened for reading:
`{ … >>/dev/stdin; } < .git/config` writes `.git/config`. A write redirection to either is to a file only known at
run time, and so is one to `/dev/stdout` or `/dev/stderr` in code that may open those for reading.
