---
packages:
  'bash-gate': patch
---

### The words after a package script are walked with it

npm, pnpm and bun append the words after a script's name to it, so `npm test -- --config /tmp/x.ts` runs
`vitest --config /tmp/x.ts`. They were dropped: the script was walked bare, and allowed. Now they're appended, quoted,
before it's walked. Where it isn't walked (no `fs`, a workspace, a word only known at run time), they're
`exec:arbitrary`.

### Project code is the project's where the script starts

`npm --prefix /tmp/x test`, `cd .. && npm test` and `git -C /tmp/x commit` ran another directory's scripts or hooks
as `exec:project`. Project code run anywhere but under where the script starts is `exec:file` now, and so is a file
given from elsewhere that a tool runs or finds configuration beside: `bun test /tmp/x.test.ts`, `bun build
../x/entry.ts` (its macros run), `eslint ../other` and `prettier ../other` (configuration beside the files),
`oxlint` and `oxfmt` likewise. `tsdown -W` and `bun --env-file` are `exec:file`. So is git with another repository
(`-C`, `--git-dir`, `--work-tree` elsewhere), whatever the command: its config may run code (`core.fsmonitor`).

### Package managers

- With no package.json where it runs, npm looks in the directories above: the `exec-config` finding for that never
  fired, so the script went unwalked and allowed.
- npm's `-C` takes a directory: `npm -C run test` runs `./run`'s test script.
- `npm -g run x` runs the local script, and is walked.
- The scripts `npm pack` and `npm version` run (`prepack`, `prepare`, `postpack`, the version scripts) are walked.
- pnpm's `with`, `ci` and `query` (which installs), and bun's `ci`, `r`, `uninstall`, `list`, `getcompletes` and
  `bun bun` are their own commands, run in place of a script of that name.

### Git rewrites from elsewhere aren't the project's

A work-tree rewrite was trusted as the repository's own content whatever it checked out: `git fetch origin pull/1/head
&& git checkout FETCH_HEAD -- package.json && npm run x` walked the old scripts. Only a rewrite from `HEAD`, the index
or a stash is a `project-file` change now; another branch or commit, a merge, rebase, cherry-pick, revert, pull or
patch makes later reads unknown.

### Others

- A prompt string's `\\` is one backslash once decoded, which escapes what follows as it's expanded.
- git opens `core.hooksPath` and include paths as given, so a `..` after a symlink leads up from where the symlink
  does. They were resolved as text.
- With `resolveJsonModule`, tsc copies JSON into its output: a package.json there is a `project-file` change after it.
- A short option spelled with a capital (`-W`) in a cac or yargs tool was given a bogus long name (`--w`), so tsdown's
  `-W` wasn't read as `--workspace`.
