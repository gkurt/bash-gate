---
packages:
  'bash-gate': minor
---

### FileSystem.readDirectory, to find repositories nested in a work tree

git looks into every repository nested in its work tree that was added as a gitlink, even one `.gitmodules` doesn't name. `git status` then runs that repository's `core.fsmonitor`.

- **Following them:** the analysis now lists the work tree to find nested repositories, and follows each as it does a submodule. Symlinks to directories aren't descended into, as git doesn't.
- **The API:** `FileSystem` and `AsyncFileSystem` gain an optional `readDirectory(path)`. It returns the names in a directory, `null` when the path isn't one, or `undefined` when that isn't known.
- **Snapshots:** `snapshot` takes `directories`, `checkAsync` fetches listings, and a listing it lacks is a `Need` of kind `'directory'`.

Without `readDirectory`, a git command run with a filesystem is now an `exec-config` finding, so it asks. A work tree with more than 50,000 directories is a finding too. Add `readDirectory` to keep `git status` allowed: with Node, `readdirSync(path)`, returning `null` on `ENOENT` and `ENOTDIR`.
