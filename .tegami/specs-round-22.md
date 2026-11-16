---
packages:
  'bash-gate': patch
---

### `switch -m`, git's gc and help keys, compilers, pnpm and bun variables, and programs that open a browser

- `recommended` asks about `git switch -m` and `--conflict`, which merge local changes into conflicts.
- Git config that makes maintenance expire reflogs or prune (`gc.reflogExpire`, `gc.pruneExpire`, `maintenance.*`),
  and that makes `git help` run a browser (`help.format`, `help.browser`, `help.htmlPath`, `man.viewer`), is a finding.
- `CC`, `CXX`, `CPP`, `AR`, `LD` and their flags (`CFLAGS`, `LDFLAGS`…), with target and host forms, are sensitive: build
  scripts run them. So are `pnpm_config_*`, `BUN_INSPECT` and `BIOME_LOG_PATH`.
- `cargo help <word>` may run `cargo-<word>`; `cargo doc --open`, `vite --open` and `npm help` may run a browser.
- `biome --log-path` names where its daemon writes.
