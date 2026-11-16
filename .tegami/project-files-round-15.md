---
packages:
  'bash-gate': patch
---

### Git's discovery, config and husky as git and husky read them

- A `.git` file is all after `gitdir: ` (spaces included), and it and `commondir` lead where the kernel goes: a `..`
  after a symlink leads up from its target. A `.git` whose `objects` or `refs` is a file isn't taken, so the
  repositories above it are followed.
- Repository discovery also starts from where the working directory really is, as git's `getcwd` does.
- Git config is parsed as git parses it: a key after its section's header, `;` and `#` comments after a value, single
  quotes as text, backslash-newline continuations. One git would refuse is an `exec-config` finding. An include under
  `~` is read from `HOME`.
- A relative `core.hooksPath` in a repository whose config says it's bare runs from where git started: a finding.
- The submodules `.gitmodules` names are followed: their config and hooks.
- A hook husky 7 or 8 runs through its helper is read as `sh`, which the helper runs it with.
- A `package.json` that gives a key twice is a finding: bun takes the first, npm the last.
