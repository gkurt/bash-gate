---
packages:
  'bash-gate': patch
---

### The words after a package script are walked with it

npm, pnpm and bun append the words after a script's name to it, so `npm test -- --config /tmp/x.ts` runs
`vitest --config /tmp/x.ts`. They were dropped: the script was walked bare, and allowed. Now they're appended, quoted,
before it's walked (bun drops a `--` right after the name; pnpm keeps it). Where it isn't walked (no `fs`, a
workspace, a word only known at run time), they're `exec:arbitrary`.

### Project code is the project's where the script starts

`npm --prefix /tmp/x test`, `cd .. && npm test` and `git -C /tmp/x commit` ran another directory's scripts or hooks
as `exec:project`. Project code run anywhere but under where the script starts is `exec:file` now, and so is a file
given from elsewhere that a tool runs or finds configuration beside: `bun test /tmp/x.test.ts`, `bun build
../x/entry.ts` (its macros run), `eslint ../other` and `prettier ../other` (configuration beside the files),
`oxlint` and `oxfmt` likewise. `tsdown -W` and `bun --env-file` are `exec:file`. So is git with another repository
(`-C`, `--git-dir`, `--work-tree` elsewhere), whatever the command: its config may run code (`core.fsmonitor`). Where is
where it really is: under a symlink to elsewhere (`cd link`), one the script may have made, or a work tree git has
rewritten, project code is `exec:file`. A relative `-C`, `--prefix` or `--cwd` after another is a place only known at
run time (git and make take it from the one before).

### Package managers

- With no package.json where it runs, npm looks in the directories above: the `exec-config` finding for that never
  fired, so the script went unwalked and allowed.
- npm's `-C` takes a directory: `npm -C run test` runs `./run`'s test script.
- `npm pack <spec>` packs another package: a directory's is `exec:file`, and one from the registry or a git host
  `network` and `exec:arbitrary` (npm installs it and runs its `prepare`).
- `npm -g run x` runs the local script, and is walked.
- The scripts `npm pack` and `npm version` run (`prepack`, `prepare`, `postpack`, the version scripts) are walked, and
  so is the commit `npm version` makes, whose hooks run.
- A flag that turns something off counts only given bare: npm reads `--ignore-scripts=false` as false, and it was
  read as `--ignore-scripts`, skipping the scripts.
- pnpm's `with`, `ci` and `query` (which installs), and bun's `ci`, `r`, `uninstall`, `list`, `getcompletes` and
  `bun bun` are their own commands, run in place of a script of that name.

### Git rewrites aren't the project's

A file git rewrote in the work tree was walked as it was before, as a `project-file` finding, whatever was checked out:
`git fetch origin pull/1/head && git checkout FETCH_HEAD -- package.json && npm run x` walked the old scripts. `HEAD`,
the index and a stash are no better: an earlier command, or this one, may have committed, staged or stashed anything
(`git stash apply FETCH_HEAD`, `git mv -f a package.json`). After any rewrite, a read in the work tree is unknown.

### Fetching dependencies

`cargo build` and the commands like it, and bun running code or tests, fetch what they haven't got: `network:read`,
which `recommended` allows for them, unless `--offline` or `--frozen` (cargo) or `--no-install` (bun).

### Others

- A prompt string's `\\` is one backslash once decoded, which escapes what follows as it's expanded.
- git opens `core.hooksPath` and include paths as given, so a `..` after a symlink leads up from where the symlink
  does. They were resolved as text.
- With `resolveJsonModule`, tsc copies the JSON its sources import into its output, from wherever it is: every `.json`
  is unknown after it, a package.json included, so `tsc && npm test` asks with `fs` (`tsc --noEmit` writes nothing).
- A short option spelled with a capital (`-W`) in a cac or yargs tool was given a bogus long name (`--w`), so tsdown's
  `-W` wasn't read as `--workspace`.
