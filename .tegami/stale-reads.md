---
packages:
  'bash-gate': patch
---

### Files the script changes before reading them are unknown

Git config and hooks, npm scripts and SSH config the script may write first (`cp -r hooks .git/ && git commit`), or write while they're read (`&`, a pipeline), are an `unknown-file` finding rather than their old contents. So is the real path of anything under a symlink the script may create (`ln -s /etc e && rm e/passwd`).
