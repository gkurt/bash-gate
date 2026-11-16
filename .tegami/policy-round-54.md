---
packages:
  'bash-gate': patch
---

### Paths with a newline, credential directories read whole, and more of the user's configuration

- **Newlines in paths:** a `**` in a policy glob now matches a newline, as do the secret file patterns. A path such as `$'../x\ny'` had escaped every `**` rule (`../**`, `.git/**`, `~/.ssh/**`), and `$'a\nb.pem'` wasn't seen as a key.
- **Credential directories:** a directory that holds credentials (`~/.ssh`, `~/.aws`, `~/.config`) is a secret read when a program may read it recursively (`grep -r '' ~/.aws`).
- **More secret files:** `credentials.json`, `secrets.yaml`/`.yml`/`.json`, `.yarnrc.yml`, and shell history.
- **terraform:** a word only known at run time after the command may be `-out`, `-state-out`, `-var-file`, `-or-create` or `-net-mirror`. It now counts as a write, a read and network.
- **The user's configuration:** `recommended` asks before writes anywhere under `~/.config`, `~/.local` and `~/.cargo`, even from a script started in HOME. That covers Python's `.pth` files, gh's and pnpm's config, and editors'. It also asks about `.bashrc.d`, oh-my-zsh, nvm, bun, Yarn, Claude, AWS, Docker, terraform, GnuPG, vim, tmux, `.pam_environment`, `.xprofile` and macOS launch agents.
