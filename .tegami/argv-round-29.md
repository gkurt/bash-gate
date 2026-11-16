---
packages:
  'bash-gate': patch
---

### Options are read as the programs' own parsers read them

- `CommandSpec.dashless`: an option's value is never a separate word starting with `-`, which is read as an option
  instead, as mri, cac, minimist, yargs and nopt's strings do. pnpm, vite, vitest, tsdown, prettier and jest are read
  so: `pnpm -C --config.script-shell=x test` sets the script shell, `vite -m dev -m --host` listens on the network.
- tsc's flags take a `true` or `false` after them: `tsc --noEmit false x.ts` emits.
- `cargo clippy --` passes its words to rustc: anything but lint levels (`-D warnings`) may run a linker or write.
- `git push --no-verify --veri` turns the hook back on: a duplicate entry kept `--veri` from being read as `--verify`.
  Duplicates in the tar, rsync, strace and biome specs are gone too, and `gh repo read-file|read-dir` take `-R`.
