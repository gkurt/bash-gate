---
packages:
  'bash-gate': minor
---

### `network:read`: `recommended` allows `git fetch`, `git ls-remote` and the `gh` commands that only read

A new effect for reading from a host already set up. `git fetch` and `git ls-remote` have it when the remote is given by its name or not at all, and so do gh's commands that look (`gh pr view`, `gh pr checks`, `gh run view`, `gh issue list`, `gh search`, `gh repo view` and the like). They keep `network` once the command line may say where to go: a URL or a path, `git -c`, `--git-dir`, `gh -R HOST/OWNER/REPO`, `--web`, an argument only known at run time, or an option the spec doesn't know.

**Breaking:** these commands no longer have `network`, so a rule naming `network` no longer matches them. Name `network:read` too to keep asking.

### A forced fetch asks

`git fetch --force`, `--refmap`, `--update-head-ok`, `--prune-tags` and a `+` refspec move or delete local refs.

### `git remote add`, `set-url`, `rename`, `remove`, `set-head` and `set-branches` write `.git/config`

`git remote set-url origin https://example.com/x.git` was allowed by `recommended`, and decides where a later fetch or push goes.

### `git ls-remote --upload-pack` is `exec:arbitrary`

It had no options in its spec, so the program it runs was an unknown option.

### `GH_HOST`, `GH_REPO` and proxy variables are sensitive

`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (and lowercase) send a program's requests through a host the command line chooses.
