---
packages:
  'bash-gate': minor
---

### What only project code may have changed is a `project-file` finding, which `recommended` allows

With a filesystem, a test run or build before a git command (`cargo test; git status`, `bun test && git stash pop`)
made git's config and hooks unknown, so the command asked, though the project code that might have changed them was
allowed to run anything itself. When the only program that may have written files no one can name is project code
the analysis doesn't follow (`exec:project`), a read after it is now a `project-file` finding, which `recommended`
allows. What was there before is still walked, so a hook that denies still denies, and real paths are kept. A policy that asks about `exec:project` still asks about the code. Anything else that
may write anything (`python3 -c`, `./build.sh`, `npm install`) still makes later reads `unknown-file`.

### What git checks out is the repository's own

A file in the work tree read after a git command rewrote it (`git stash pop && git commit`, with husky's hooks in
`.husky`; `git checkout main && npm test`) is a `project-file` finding too, and what was there is walked. Real paths in
the work tree stay unknown after such a command, since a commit may hold a symlink.

### A program's redirection no longer makes every later read unknown

`cat a > out && git commit` asked with a filesystem: the redirection gave `cat` a write its spec didn't name, which
counted as a program writing files no one can name. A redirection's writes are named, and now count as only those.
