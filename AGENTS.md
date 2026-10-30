# AGENTS.md

## Commands

```bash
bun run test       # All tests, including test/bash.test.ts (skipped without bash)
bun run typecheck  # tsc (TypeScript 7)
bun run checks     # Both
bun run build      # dist/ via tsdown (ESM and .d.ts), what npm gets
```

`PROPERTY_RUNS` and `METAMORPHIC_RUNS` set how many cases the generated tests try. CI (`.github/workflows/ci.yml`)
runs everything on Linux, then builds and loads `dist/` in Node.

## Structure

- `src/words.ts`: word resolution (quotes, braces, variables, field splitting) into static or dynamic `Arg`s.
- `src/analyze.ts`: the walk. Shell state (variables, functions, aliases, `hash`, `enable`, `cd`), dispatch (alias,
  function, builtin, program), wrappers, and code inside strings.
- `src/argv.ts`: reads argv with a `CommandSpec`. Canonical options, subcommands, nested command lines.
- `src/specs.ts`: program specs, plus git's config keys that run code.
- `src/policy.ts`: three-valued rule matching and the verdict. `src/recommended.ts`: the starting policy.
- `src/paths.ts`: path resolution against the tracked working directory.

## Rules for changes

- Fail closed: anything the analysis can't follow becomes a dynamic `Arg`, `maybeOptions`, `open`, or a finding. It
  never disappears.
- A new construct or spec gets a case in `test/escapes.test.ts`. If it changes what runs, it also gets a script in
  `test/bash.test.ts`, which checks the analysis against real Bash.
- Check Bash semantics in Bash before encoding them, with harmless commands (`echo`).
