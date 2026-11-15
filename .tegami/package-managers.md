---
packages:
  'bash-gate': minor
---

### `recommended` allows package scripts, tests and builds

The README said `recommended` didn't ask about project code (`exec:project`), but no rule allowed `npm test`. It now
allows what `npm`, `pnpm`, `bun` and `cargo` run of the project (`npm test`, `pnpm lint`, `bun typecheck`,
`cargo build`), as it does git hooks, and still asks when they install, publish, delete, or run code the analysis
can't place.

### Specs for pnpm, bun and cargo

- pnpm and `bun run` run a command from PATH when no script has the name (`pnpm node -e …`): that command is
  walked like a wrapper's, unless the filesystem shows the script is there. `bun lint` runs `lint.ts` when no script
  is named `lint`.
- Inline code (`bun -e`), preloaded modules, a debugger, `bunx`, `pnpm dlx` and cargo's `--config` and `-Z` are
  `exec:arbitrary`, `exec:file` or `network`. A word cargo doesn't know runs the program `cargo-<word>`.
- With `fs`, the package.json scripts pnpm and bun run are walked as npm's are, `pre` and `post` scripts included.
  A workspace's scripts (`--filter`, `-r`) aren't followed. Without a package.json where the command runs, one above
  it may be used: an `exec-config` finding.

### npm reads more like npm

- A word npm doesn't know is the start of one of its commands' names (`npm exe` runs `npm exec`), and an option it
  doesn't know is configuration that may name the shell scripts run in (`--script-shell`): both are
  `exec:arbitrary`. So is `npm config set`.
- `npm pkg set` and `npm version` write the package.json, so scripts read after them are unknown. `npm version` and
  `npm pack` run scripts, and npm's other commands have their effects (`edit`, `explore`, `docs`, `cache`…).
- A package.json without `scripts` runs none, where it used to be an `exec-config` finding.
