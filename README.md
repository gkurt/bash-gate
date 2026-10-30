# bash-gate

Static analysis of Bash commands: every program a command line may run, with its subcommands, options, paths and
effects, and a policy that allows, asks about or denies it. Built for gating the commands an AI agent runs, but the
analysis stands on its own: highlighting, auditing, explaining commands.

Prototype. Parsing is [unbash](https://github.com/webpro-nl/unbash); everything else is here. It runs anywhere
JavaScript does: no Node APIs, no native code.

```sh
npm install bash-gate
```

```ts
import { check, recommended } from 'bash-gate';

check('git status && rm -rf /', recommended).decision; // 'deny'
check('sudo env FOO=1 bash -c "rm -rf /"', recommended).decision; // 'deny'
check('git push origin +main', recommended).decision; // 'deny' (a + refspec forces)
check('xargs rm -rf < list', recommended).decision; // 'ask' (the paths come at run time)
check('rg TODO src | head', recommended).decision; // 'allow'
```

`analyze(source)` gives the invocations without a policy:

```ts
analyze('sudo -u root rm -rf "$dir"').invocations.map((i) => [i.shape, i.via, i.effects]);
// [['sudo --user=<v>', [], ['privilege']],
//  ['rm --force --recursive <dynamic>', ['sudo'], ['fs:delete']]]
```

## How it works

1. **Parse** with unbash. Any parse error, nested ones included, is a finding, so the command can't be allowed.
2. **Resolve words** (`src/words.ts`): quotes and escapes removed, braces expanded, known variables substituted, unquoted
   expansions split. A word is either static strings or one dynamic argument that says why (`variable`, `glob`,
   `substitution`…) and whether it may become several words.
3. **Walk with shell state** (`src/analyze.ts`): variables (constant propagation, joined across branches, made dynamic by
   loops), functions, aliases (only with `expand_aliases`, and only from the next line), `hash -p`, `enable -n/-f`,
   `cd`, exports into child shells. Subshells, pipelines and substitutions get copies of the state.
4. **Dispatch** as Bash does: alias, then function, then builtin, then program. `command`, `builtin` and `exec` change
   that order. `eval`, `trap`, `mapfile -C`, `compgen -C`, `bash -c`, `ssh host cmd`, `watch`, git aliases and git config
   commands parse their strings and walk them as code.
5. **Read argv with a spec** (`src/specs.ts`, `src/argv.ts`): options under canonical names (`-f`, `--forc`, `-fu` →
   `--force`), clusters, attached values, `--`, POSIX vs GNU ordering, subcommands, paths read and written, and the
   command lines that wrappers run (`sudo`, `env`, `timeout`, `xargs`, `find -exec`, `git bisect run`…).
6. **Decide** (`src/policy.ts`). Every condition has three outcomes: it matches, it doesn't, or it may (a dynamic word
   could match it). Deny beats ask, and ask beats allow. A deny rule that only may match asks, or denies with
   `strict: true`.

## Rules

```ts
import { allow, ask, deny, type Policy } from 'bash-gate';

const policy: Policy = {
  default: 'ask',
  rules: [
    allow('git status|log|diff'),
    deny('git push', { options: ['-f', '--force-with-lease'], reason: 'No force pushes' }),
    deny('rm', { options: ['-r'], args: ['/', '/*', '~', '~/*'] }),
    ask({ effects: ['network', 'exec:arbitrary'] }),
    ask({ writes: ['/**', '~/**', '../**'] }),
  ],
};
```

- `command`: the program, then subcommands, alternatives after `|`, and `*` for any.
- `options`: any of these options is given, spelled however the spec allows.
- `args` and `writes`: globs matched against paths as written and as resolved against the tracked working directory.
- `effects`: `fs:read`, `fs:write`, `fs:delete`, `network`, `privilege`, `exec:arbitrary`, `exec:project`, `exec:file`,
  `exec:remote`, `shell-state`.
- An allow rule never applies to a program given by a non-system path (`./ls`).
- Findings (`parse-error`, `dynamic-command`, `dynamic-script`, `sensitive-variable`, `exec-config`, `loads-code`,
  `unknown-alias`, `too-deep`) ask unless `policy.findings` says otherwise.

`recommended` (`src/recommended.ts`) is a starting point. It allows reading and everyday git, denies force pushes and
deleting top-level directories, and asks about deleting, network, privilege, code it can't see, and writes outside
the working directory. It does not ask about `exec:project` (`npm test`, `make`, git hooks); add that if it matters.

## Tests

```sh
bun run checks   # tsc, then bun test
```

- `test/escapes.test.ts`: about 100 commands and the decision `recommended` must reach. They cover quoting, braces,
  variables, substitutions in odd places, wrappers, strings run as code, functions, aliases, `hash -p`, git refspecs
  and config.
- `test/analyze.test.ts`: word resolution, option parsing, shapes, spans and state.
- `test/metamorphic.test.ts`: generated chains of equivalent rewrites of denied and asked commands, plus rewrites that
  hide values, checked under strict and non-strict policies. Set `METAMORPHIC_RUNS` to change the number of cases.
- `test/bash.test.ts`: runs scripts in real Bash with a `PATH` of logging stubs. Every program that ran must be one
  the analysis predicted, with those arguments. This is the check that keeps the analysis honest. Extend it before
  trusting a new construct.

## Known gaps

- **Bash only.** zsh, fish, PowerShell and cmd.exe need adapters that produce the same invocations.
- **Specs cover a few dozen programs.** Programs without one get their options guessed. Programs that run code
  through their arguments aren't described yet: `sed`'s `e`/`w`, `awk`'s `system()`, `tar --to-command`,
  `rsync -e`, `vim -c`, `less`, `zip -TT` and the rest of [GTFOBins](https://gtfobins.github.io/).
- **Project code isn't analysed.** `npm test`, `make` and git hooks are flagged `exec:project`. A repository's
  `.git/config` can make any git command run code (`core.fsmonitor`); only `-c` and `git config` entries are seen.
- `PS4` and `PROMPT_COMMAND` values aren't parsed as code. Setting them is only a `sensitive-variable` finding.
- Arithmetic evaluates variables' values as expressions, so `(( x ))` runs `$(…)` in `x`'s value. That's followed
  only for literal subscripts.
- Aliases ending in a space (which expand the next word too) aren't handled. Line numbers for aliases inside `eval`
  strings are approximate.
- Paths: `~` isn't expanded to a real home, and symlinks aren't known.
- A loop body is walked twice, so deeply nested loops cost exponentially more (depth is bounded).
