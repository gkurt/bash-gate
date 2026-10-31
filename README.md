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
3. **Walk with shell state** (`src/analyze.ts`): variables (constant propagation, joined across branches, loops walked
   until they settle), functions, aliases, `hash -p`, `enable -n/-f`, `cd`, exports into child shells. Aliases expand
   as Bash parses: with `expand_aliases`, POSIX mode, `sh` or an interactive shell, from the next line, and in a
   function body as they were when it was defined. Subshells, pipelines and substitutions get copies of the state.
4. **Dispatch** as Bash does: alias, then function, then builtin, then program. `command`, `builtin` and `exec` change
   that order. `eval`, `trap`, `mapfile -C`, `compgen -C`, `bash -c`, `ssh host cmd`, `watch`, git aliases, git config
   commands, prompt strings (`PS4`) and `PROMPT_COMMAND` parse their strings and walk them as code. Code for other
   shells (`zsh -c`, `fish -c`, `pwsh`) is never parsed as Bash: it's code the analysis can't see into.
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
  `check` and `evaluate` also accept an optional `realpath` callback; it is called only with an absolute path when the
  invocation has an absolute `cwd`. Deny and ask rules match any path form. Allow rules must match a known path form
  and the real path.
  When `$HOME` is known (set in the script, or given in `env`), `~` globs match absolute paths under it, and the other
  way round. Another user's home (`~root`) may be anywhere.
- `effects`: `fs:read`, `fs:write`, `fs:delete`, `network`, `privilege`, `exec:arbitrary`, `exec:project`, `exec:file`,
  `exec:remote`, `shell-state`.
- An allow rule never applies to a program given by a non-system path (`./ls`).
- Findings (`parse-error`, `dynamic-command`, `dynamic-script`, `dynamic-arithmetic`, `sensitive-variable`,
  `exec-config`, `loads-code`, `unknown-alias`, `too-deep`) ask unless `policy.findings` says otherwise.

`recommended` (`src/recommended.ts`) is a starting point. It allows reading and everyday git, denies force pushes and
deleting top-level directories, and asks about deleting, network, privilege, code it can't see, writes outside the
working directory, and writes to `.git/config` or `.git/hooks`. It does not ask about `exec:project` (`npm test`,
`make`, git hooks); add that if it matters.

`analyze` has an optional `readFile(path)` hook. It should return `undefined` for missing or non-file paths; callback
errors otherwise propagate. When provided, Git repository config (including `include.path` and
`.git` pointer files), applicable Git hook scripts, SSH config files passed with `-F`, and npm lifecycle scripts are
read and walked as code. The library uses no Node filesystem APIs. `make` remains `exec:project`; Makefiles aren't
parsed.

## Tests

```sh
bun run checks   # tsc, then bun test
```

- `test/escapes.test.ts`: about 130 commands and the decision `recommended` must reach. They cover quoting, braces,
  variables, substitutions in odd places, wrappers, strings run as code, functions, aliases, `hash -p`, loops, prompt
  strings, `~` paths, other shells, git refspecs and config.
- `test/analyze.test.ts`: word resolution, option parsing, shapes, spans and state.
- `test/metamorphic.test.ts`: generated chains of equivalent rewrites of denied and asked commands, plus rewrites that
  hide values, checked under strict and non-strict policies. Set `METAMORPHIC_RUNS` to change the number of cases.
- `test/bash.test.ts`: runs scripts in real Bash with a `PATH` of logging stubs. Every program that ran must be one
  the analysis predicted, with those arguments. This is the check that keeps the analysis honest. Extend it before
  trusting a new construct.

## Known gaps

- **Bash only.** zsh, fish, PowerShell and cmd.exe need adapters that produce the same invocations. Until then, their
  code run from Bash (`zsh -c`, `pwsh -Command`) counts as `exec:arbitrary`.
- **Program specs are intentionally conservative.** The listed `sed`, `awk`, `tar`, `rsync`, `vim`, `zip`, `ssh`,
  output-file and command-wrapper forms are flagged or followed where their arguments identify code or paths. Some
  language-specific snippets are effect findings rather than fully interpreted programs, and other programs remain
  unspecified. `less` and `more` are not on the recommended read allowlist because their command modes can run code.
- **Project code depends on the integration.** Without `readFile`, npm scripts, Git hooks and config includes cannot be
  followed; commands remain `exec:project`, and the recommended policy asks about direct writes to `.git/config` and
  `.git/hooks/**`. `make` is `exec:project` and Makefiles aren't parsed.
- **Code that runs later is walked as of when it's set.** Trap actions, prompt strings and `PROMPT_COMMAND` see the
  variables, functions and aliases of the moment they're defined, not of when they run.
- Dynamic arithmetic values are findings unless the analyzer can establish they are numeric. Static values are
  recursively followed in arithmetic commands, expansions, loops, `let`, integer tests, array indices, substring
  offsets and integer declarations.
- An aliased command with a here-document is parsed again without the document's body: a parse error, which asks.
- Paths: `~` is only a real directory when `$HOME` is known. Symlinks are resolved only when the caller provides
  `realpath` and an absolute working directory.
- The walk has a work budget. A script past it gets a `too-deep` finding rather than a full analysis.
