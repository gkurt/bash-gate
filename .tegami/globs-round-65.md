---
packages:
  'bash-gate': patch
---

### Secret globs with classes, negated sets, escapes, `**` and `~-`

- **Bracket expressions as Bash closes them:** a POSIX class, equivalence class or collating symbol (`.[[:alpha:]]nv`, `.[[=e=]]nv`) no longer ends the set at its own `]`. A negated set (`.[!A-Z]nv`) is no longer turned around by ignoring case. Both may match `.env`, and now ask.
- **Escapes:** a backslash in a pattern from a variable escapes the next character, as Bash 5.2 reads it (`x='.e\nv*'; cat $x` reads `.env`). It was read as a path separator.
- **`**`:** a glob with a `**` part under a directory that holds secrets (`~/.gnupg/**`, `~/.local/**`) is a secret read, as `globstar` reads every file below it.
- **Tildes not placed:** `~-`, `~N` and `~+N` name a directory only known at run time, so `~-/*` may read any file there.
