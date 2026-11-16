---
packages:
  'bash-gate': minor
---

### `recommended` asks about the user's own configuration from HOME too

Writes to `~/.gitconfig`, `~/.config/git/`, `~/.ssh/` and the shell startup files (`~/.bashrc`, `~/.profile`, `~/.zshrc`
and the like) ask even when the script starts in HOME, where `..` doesn't reach them: git and the shell run what they
say later.
