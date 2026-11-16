---
packages:
  'bash-gate': patch
---

### The user's configuration is matched by HOME as it started, by `~/bin`, and by Windows short names

- `~` globs also match from HOME as the script started (`Analysis.home`): `declare -a HOME`, which leaves HOME as it
  was but unknown to the analysis, no longer hides `~/.bashrc`.
- `recommended` asks about `~/bin`, which Ubuntu's `.profile` puts on PATH.
- A path with a Windows 8.3 short name (`BASHRC~1`, `SSH~1/…`) may be any file it shortens: path rules may match it.
