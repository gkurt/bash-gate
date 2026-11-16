---
packages:
  'bash-gate': patch
---

### More git config keys and build tools' deletes are caught

- `protocol.allow` (which lets an `ext::` remote run a command), `http.cookieFile` (which git writes cookies to),
  `mergetool.*.path`, `difftool.*.path` and `sendemail.smtpServer` are git config keys that change what git runs or
  writes: in a repository's config or given with `-c`.
- `vite build --outDir` (or `--emptyOutDir`) empties the directory first, and `tsdown -d` cleans its out-dir:
  both are `fs:delete`.
