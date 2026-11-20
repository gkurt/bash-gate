---
packages:
  bash-gate: patch
---

### Git after `git add` lists the work tree without what `.gitignore` ignores

After a plain `git add`, `git commit` or `git rm`, the search for repositories nested in the work tree skips the
directories the work tree's `.gitignore` files ignore, such as `node_modules`, and follows the gitlinks the index held.
A forced `git add`, any other git that writes the index, or a `.gitignore` the script changed still lists everything. A
git command in a pipeline, as in `git log | head`, no longer lists the work tree unless another command of the
pipeline runs git that writes the index.
