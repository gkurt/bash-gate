---
packages:
  'bash-gate': patch
---

### `recommended` asks about every dotfile in HOME, the agent's project settings, and more system paths

- **HOME:** writes to any dotfile or dot directory in HOME ask, in place of a list of names, which missed files that run code later: `~/.bash_completion` (which Ubuntu's `.bashrc` sources), `~/.vim/plugin` and `~/.vim/vimrc`, `~/.rustup`'s toolchains, version managers' shims, `~/.gdbinit` and others. So do `~/go/bin`, as `~/bin` did. A project that lives in a dot directory of HOME (`~/.dotfiles`) now asks on every write.
- **The agent's project settings:** writes to `.claude/` and `.mcp.json` in the project (and below it) ask, as `~/.claude` did: they hold the agent's permissions, hooks and MCP servers.
- **System paths:** `/opt`, `/var/spool` (cron's), `/run/systemd` and macOS's `/private/etc` ask, even from a script started at `/`.
- **Case folding:** `ſ` (long s) folds to `s`, as Unicode's case folding has it, so `~/.ſsh` matches `~/.ssh` on a filesystem that folds it.
