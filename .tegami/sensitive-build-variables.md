---
packages:
  'bash-gate': patch
---

### Cargo, rustc, bun and less variables are sensitive

`CARGO_*` (a runner, a rustc wrapper, `CARGO_HOME`'s config, a target directory), `RUSTC`, `RUSTC_WRAPPER`,
`RUSTC_WORKSPACE_WRAPPER`, `RUSTDOC`, `RUSTFLAGS`, `RUSTDOCFLAGS`, `RUSTUP_TOOLCHAIN`, `RUSTUP_HOME`, `BUN_OPTIONS`
(`--preload`), `LESS` (a `+!` command git's pager runs) and `LESSKEY*` make the programs they're given to run code or
write elsewhere, as their options do.
