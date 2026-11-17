---
packages:
  'bash-gate': patch
---

### npm's and pnpm's config read as they read it, in the project and above it

- **`.npmrc` as npm's ini reads it:** a key is trimmed as JavaScript trims (a byte-order mark, a no-break space or a vertical tab before it too), and a quoted key is decoded. `"script-shell"=/elsewhere/prog` names the shell npm runs scripts with, as `script-shell=…` does.
- **Above the project:** npm reads the `.npmrc` of a workspace root above the project in place of the project's, and pnpm its `pnpm-workspace.yaml`. Both are now read in every directory from the project up to HOME.
- **Workspaces from `.npmrc`:** a `workspace`, `workspaces` or `include-workspace-root` setting runs other packages' scripts, as `-w` does: they aren't walked.
- **pnpm's `scriptShell`:** `pnpm-workspace.yaml`'s `scriptShell` is the shell pnpm 11 runs scripts with: `exec:file`, or `exec:arbitrary` when it isn't written as `scriptShell: value`.
- **Snapshots:** a snapshot that doesn't record whether `.npmrc` and `pnpm-workspace.yaml` exist in the directories above the project now asks on `npm test` and `pnpm test`.
