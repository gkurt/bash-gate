---
packages:
  'bash-gate': patch
---

### A project .npmrc's script-shell is a program of its own

With a filesystem, the project's `.npmrc` is read before npm or pnpm runs package scripts.

When it names another `script-shell`, the scripts run with that program instead of `sh`, so they aren't walked as shell code:

- a program named by path or name is `exec:file`, and a read of that program;
- one that comes from the environment (`${VAR}`) is `exec:arbitrary`.

An `.npmrc` the script may have changed before it's read is a finding, as `package.json` is. A snapshot that leaves `.npmrc` unknown now asks; give it as `null` when it isn't there.
