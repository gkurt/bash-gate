---
packages:
  'bash-gate': minor
---

### FileSystem takes just-bash's and Node's shape, each method optional and sync or async

`fs` can be a just-bash `IFileSystem` or Node's `fs` functions as they are: `readFile(path, 'utf8')`, `readFileBuffer`, `readdir`, `realpath` and `lstat`. An `ENOENT`, `ENOTDIR` or `EISDIR` error means nothing is there, and `lstat` tells a dangling symlink from nothing. `check` throws a `TypeError` on a promise, and `checkAsync` takes the same `FileSystem`. `AsyncFileSystem` is gone, and `snapshot` takes `buffers` and gives only the methods whose records it's given.

### Repositories nested in a work tree that git looks into

git looks into every repository its index records as a gitlink, even one `.gitmodules` doesn't name, and runs its `core.fsmonitor`. The analysis reads the gitlinks from `.git/index` (versions 2 to 4). A command that checks out another commit, or one after git may have changed the index, looks into every repository in the work tree, found with `readdir`. Where neither can be read, the git invocation has the new effect `exec:nested`, which `recommended` allows.
