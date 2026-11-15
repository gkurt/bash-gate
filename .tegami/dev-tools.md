---
packages:
  'bash-gate': minor
---

### `recommended` allows the tools project scripts run

`tsc`, `tsgo`, `biome`, `oxlint`, `oxfmt`, `eslint`, `prettier`, `vitest`, `jest`, `tsdown` and `vite` have specs and
run, so a script made of them is allowed with a filesystem. They still ask when they write outside the working
directory (`prettier --write ~/x`, `tsc --outDir ../x`, in any case tsc reads), delete (`tsc -b --clean`), or listen
beyond this machine (`vite --host`).

### `tsc` and `biome` write only files of their kinds

After `tsc`, only what it emits (`.js`, `.d.ts`, `.map`, `.tsbuildinfo`) is unknown, and after `biome` only what it
formats, so `tsc && git commit` still reads the hooks. The tools that load JavaScript configuration may still write
anything.

### A pipeline's commands don't change what each other read before them

A read in a pipeline was unknown after anything the script wrote, the reader's own later writes included, so
`npm test | tail` asked whenever the test script ran something unspecified. Now only the pipeline's other commands
count, and with `&` or `<(…)` the rest of the script.

### `git worktree list` runs

`git worktree` has its subcommands: `list` writes nothing, `add` checks out where it says and runs post-checkout.
