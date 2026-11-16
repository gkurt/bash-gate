---
packages:
  'bash-gate': patch
---

### nopt's `true` and `false`, find's `-` and `,`, `uniq +N`, and bun's timings file

- npm and pnpm read a `true` or `false` after a flag as its value (`pnpm --color false exec …`), as nopt does; a
  `CommandSpec` says so with `nopt`. A word only known at run time there may be one.
- find takes `-` alone, and `)` or `,` first, as paths, which `-delete` deletes.
- `uniq +N in out` writes `out`: `+N` is the old spelling of `-s N`.
- `bun test --timings <file>` takes the next word, and with `--update-timings` rewrites that file.
