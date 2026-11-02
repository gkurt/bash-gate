# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Commands

```bash
bun run test       # All tests, including test/bash.test.ts (skipped without bash)
bun typecheck      # tsc (TypeScript 7) over everything, then src/ alone with no runtime types
bun run lint       # Oxlint
bun run format     # Oxfmt
bun run fix        # Lint + format + autofix
bun run checks     # Everything: check + typecheck + test
bun run build      # dist/ via tsdown (ESM and .d.ts), what npm gets
bun dev            # The website (site/) in Vite, at localhost:4194
bun run site:build # site/dist, what GitHub Pages gets
```

Prefer these scripts over ad-hoc commands. Do not prefix them with `bun run` when a bare alias exists (`bun check`,
`bun typecheck`) — those are whitelisted for agent use. Before finishing, run `bun run fix` then `bun run checks` — the
linter, formatter and `tsc` own all mechanical style rules. Fix the code; don't disable rules.

`PROPERTY_RUNS`, `METAMORPHIC_RUNS`, `BASH_RUNS`, `MUTATION_RUNS` and `TRACE_RUNS` set how many cases the generated tests try. CI (`.github/workflows/ci.yml`)
runs everything on Linux, then builds and loads `dist/` in Node.

## Project Structure

- `src/words.ts`: word resolution (quotes, braces, variables, field splitting) into static or dynamic `Arg`s.
- `src/analyze.ts`: the walk. Shell state (variables, functions, aliases, `hash`, `enable`, `cd`), dispatch (alias,
  function, builtin, program), wrappers, and code inside strings. What the script writes, against which file reads
  and real paths become unknown.
- `src/argv.ts`: reads argv with a `CommandSpec`. Canonical options, subcommands, nested command lines, and cobra's
  rules for Go programs (`readCobra`).
- `src/specs.ts`: program specs, plus git's config keys that run code. The `gh` spec's subcommands and options follow
  `gh help reference`.
- `src/policy.ts`: three-valued rule matching, the verdict, and `checkAsync`. `src/recommended.ts`: the starting
  policy.
- `src/files.ts`: the `FileSystem` the analysis reads, `snapshot`, and what it didn't know (needs).
- `src/paths.ts`: path resolution against the tracked working directory.
- `src/cover.ts`: whether an analysis covers a process a run started (S1): `covers` and `predicting`.
- `src/trace/`: layer 3, `bash-gate/trace`. `index.ts` runs a command under `supervisor.c` (ptrace and seccomp, x86_64
  Linux) and checks each exec against the analysis: refused in `enforce` mode, reported in `trace` mode. The only code
  that uses Node APIs, so `src/tsconfig.json` leaves it out.
- `THREAT_MODEL.md`: the assumptions and promises (S1–S5), and which test checks each.
- `site/`: the website (Vite, no framework), deployed to GitHub Pages by `pages.yml`. It runs the library in the
  browser: the home page's playground and the tutorial's lessons (`site/src/tutorial.ts`) are live, and `site/tsconfig.json`
  adds the DOM types.

## Rules for changes

- Fail closed: anything the analysis can't follow becomes a dynamic `Arg`, `maybeOptions`, `open`, or a finding. It
  never disappears.
- A new construct or spec gets a case in `test/escapes.test.ts`. If it changes what runs, it also gets a script in
  `test/scripts.ts`, which `test/bash.test.ts` checks against real Bash and, on x86_64 Linux, `test/trace.test.ts`
  against every exec the kernel sees.
- Check Bash semantics in Bash before encoding them, with harmless commands (`echo`).
- `unbash` stays pinned to an exact version: a parser that disagrees with Bash is the classic bypass.

## Coding Conventions

- Bun runs the scripts and tests, but code is written against Node: `node:*` modules, never `Bun.*` (`tsc` has only
  the `bun:test` module's types). `src/` outside `src/trace/` uses no runtime APIs at all: `src/tsconfig.json` has no
  Node, Bun or DOM types, so the main entry runs wherever JavaScript does.
- Prefer colocation.
- Avoid verbose code comments; write self-explanatory code. Comments are acceptable for:
  - Explaining complex logic, workarounds, or decisions
  - Documenting public APIs (functions, classes, modules)
  - TODO/FIXME notes
  - When the user specifically asks for comments
- Prefer early returns and guard clauses over nested conditionals.
- Check for existing utilities/hooks/components before creating new ones. Avoid duplication.
- Remove dead and commented-out code; don't preserve old APIs unless asked.
- Line endings are LF, on every OS. Scripts that write files must write LF too: on Windows, Python's text mode writes CRLF unless opened with `newline=''`.
- When moving or relocating code (functions, components, utilities), don't leave a re-export behind for backwards compatibility. Update every importer to point at the new location and delete the old definition, so there is a single source of truth.

## Documentation

When changing user-facing APIs, update all relevant docs in the same change:
README.md, THREAT_MODEL.md, AGENTS.md, and the site's pages (`site/`). Documentation must not go stale.

Every change that ships in the package needs a Tegami changelog entry (`.tegami/<slug>.md`); see the `changelog`
skill.
