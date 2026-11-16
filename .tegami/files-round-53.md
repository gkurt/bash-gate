---
packages:
  'bash-gate': patch
---

### Nested submodules, husky under a hooks path ending in `..`, and more of the user's startup files

- **Nested submodules:** with a filesystem, a submodule's own submodules are followed too. `git status` in the top repository runs a nested submodule's `core.fsmonitor`.
- **husky hooks paths:** a husky 9 stub under a `core.hooksPath` that ends in `.` or `..` (`.husky/x/..`) is a finding. husky's dispatcher works out the project's hook from the path's text, so it runs `.husky/x/pre-commit`, not the hook the folded path leads to.
- **The user's startup files:** `recommended` now asks before writes to more files that run code later, even from a script started in HOME:
  - husky's init scripts (`~/.config/husky/init.sh`, `~/.huskyrc`), which every hook it runs sources;
  - fish's, systemd's, `environment.d`'s and autostart's configuration under `~/.config`;
  - `~/.cargo/bin`, which is on PATH.
