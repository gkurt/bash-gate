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
    ask({ writes: ['..', '../**', '~/**'] }),
  ],
};
```

- `command`: the program, then subcommands, alternatives after `|`, and `*` for any.
- `options`: any of these options is given, spelled however the spec allows.
- `args` and `writes`: globs matched against paths as written, as resolved against the tracked working directory, and
  as their real path when the analysis had a filesystem (see below). Deny and ask rules match any path form, and may
  match a path whose real path isn't known. Allow rules must match a known path form and, with a filesystem, the real
  path, so they never match a path whose real path can't be known. They don't match a path as written, since after a
  `cd` it names another place (`cd /tmp && echo x > src/a`); a non-path positional fails them once the script leaves
  where it started. When `$HOME` is known (set in the script, or given
  in `env`), `~` globs match absolute paths under it, and the other way round. Another user's home (`~root`) may be
  anywhere. Relative globs (`src/**`, `../**`) also match paths from where the script starts, when `cwd` was given as
  an absolute path (and from its real path, with a filesystem). Without it, an absolute path may be anywhere against
  the start, so it may match a deny or ask rule's relative glob.
- `effects`: `fs:read`, `fs:write`, `fs:delete`, `network`, `privilege`, `exec:arbitrary`, `exec:project`, `exec:file`,
  `exec:remote`, `shell-state`.
- An allow rule never applies to a program given by a non-system path (`./ls`).
- Findings (`parse-error`, `dynamic-command`, `dynamic-script`, `dynamic-arithmetic`, `sensitive-variable`,
  `exec-config`, `loads-code`, `unknown-alias`, `too-deep`, `unknown-file`) ask unless `policy.findings` says
  otherwise.

`recommended` (`src/recommended.ts`) is a starting point. It allows reading and everyday git, denies force pushes and
deleting top-level directories, and asks about deleting, network, privilege, code it can't see, writes outside the
working directory (`..`, `../**`, `~/**`: an absolute path counts as outside unless `cwd` shows it's inside), and
writes to `.git`, `.git/config` or `.git/hooks`. It does not ask about `exec:project` (`npm test`,
`make`, git hooks); add that if it matters.

## The environment

`analyze` and `check` take an optional `Environment`: the starting `cwd` (absolute), the variables in `env`, `maxDepth`,
and `fs`, the filesystem as it is before the command runs. Everything in it is plain data or synchronous, so it works
wherever JavaScript does; the library uses no Node filesystem APIs.

```ts
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { check, recommended, type FileSystem } from 'bash-gate';

const absent = (error: unknown) => ['ENOENT', 'ENOTDIR', 'EISDIR'].includes((error as { code?: string }).code ?? '');
const fs: FileSystem = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
  },
  realpath(path) {
    try {
      return realpathSync(path);
    } catch (error) {
      if (!absent(error)) throw error;
      // A dangling symlink isn't nothing: where it points isn't known.
      return lstatSync(path, { throwIfNoEntry: false }) ? undefined : null;
    }
  },
};
check('git commit -m wip', recommended, { cwd: process.cwd(), fs });
```

With `fs`, Git repository config (including `include.path` and `.git` pointer files), the Git hooks a command runs,
SSH config files passed with `-F`, and npm lifecycle scripts are read and walked as code, and each invocation gets the
`realpaths` of its paths. `make` remains `exec:project`; Makefiles aren't parsed.

- `readFile(path)` returns the text, `null` when nothing is there or it isn't a file, or `undefined` when it isn't
  known. `realpath(path)` returns where an absolute path really is, `null` only when nothing at all is there (not even a
  dangling symlink; then its parent is tried, so files that don't exist yet have a real path), or `undefined`.
- What isn't known becomes an `unknown-file` finding, and an entry in `analysis.needs`: `{ kind: 'file' | 'realpath',
  path }`. Errors thrown by the callbacks propagate.
- The answers are about the filesystem _before_ the command. A file the script may write before it's read
  (`cp -r hooks .git/ && git commit`), or while it's read (a pipeline, `&`, `<(…)`), is an `unknown-file` finding.
  A write may go through a symlink, so without an absolute `cwd` any write makes later reads unknown. A path under one
  the script may put a symlink on (`ln`, `cp`, `mv`, `tar`…) has no known real path. `mkdir`, `touch` and `chmod` change nothing a read sees. Only the writes the specs
  and redirections show count: what an unspecified program writes is out of scope.

`snapshot({ files, realpaths })` builds a `FileSystem` from records: a path in neither isn't known. Where the
filesystem is only reachable asynchronously (a browser, a remote sandbox), `checkAsync` analyses with what it has,
fetches the needs, and goes again:

```ts
import { checkAsync, recommended, type AsyncFileSystem } from 'bash-gate';

const fs: AsyncFileSystem = { readFile: (path) => sandbox.read(path), realpath: (path) => sandbox.realpath(path) };
const verdict = await checkAsync('git commit -m wip', recommended, { cwd: '/repo', fs }, { rounds: 8 });
```

Only content that names the next file costs a round: finding `.git` above a directory takes one, its hooks and
includes another. Needs left after the last round stay findings, so the command asks.

## Tests

```sh
bun run checks   # tsc, then bun test
```

- `test/escapes.test.ts`: about 130 commands and the decision `recommended` must reach. They cover quoting, braces,
  variables, substitutions in odd places, wrappers, strings run as code, functions, aliases, `hash -p`, loops, prompt
  strings, `~` paths, other shells, git refspecs and config. A few more run with a filesystem: hooks walked, and
  written before or while git reads them.
- `test/analyze.test.ts`: word resolution, option parsing, shapes, spans and state; with a filesystem, which reads and
  real paths the script's writes make unknown, needs, and `checkAsync`.
- `test/metamorphic.test.ts`: generated chains of equivalent rewrites of denied and asked commands, plus rewrites that
  hide values, checked under strict and non-strict policies. Set `METAMORPHIC_RUNS` to change the number of cases.
- `test/bash.test.ts`: runs scripts in real Bash with a `PATH` of logging stubs. Every program that ran must be one
  the analysis predicted, with those arguments. This is the check that keeps the analysis honest. Extend it before
  trusting a new construct. Besides the hand-written scripts, it generates scripts that mix variables, functions,
  aliases, `hash -p`, loops, substitutions, `eval`, `bash -c` and traps over a few shared names. Set `BASH_RUNS` to
  change the number of generated scripts.

## Known gaps

- **Bash only.** zsh, fish, PowerShell and cmd.exe need adapters that produce the same invocations. Until then, their
  code run from Bash (`zsh -c`, `pwsh -Command`) counts as `exec:arbitrary`.
- **Program specs are intentionally conservative.** The listed `sed`, `awk`, `tar`, `rsync`, `vim`, `zip`, `ssh`,
  output-file and command-wrapper forms are flagged or followed where their arguments identify code or paths. Some
  language-specific snippets are effect findings rather than fully interpreted programs, and other programs remain
  unspecified. `less` and `more` are not on the recommended read allowlist because their command modes can run code.
- **Project code depends on the integration.** Without `fs`, npm scripts, Git hooks and config includes cannot be
  followed; commands remain `exec:project`, and the recommended policy asks about direct writes to `.git`,
  `.git/config` and `.git/hooks`. `make` is `exec:project` and Makefiles aren't parsed.
- **What a program writes is what its spec says.** With `fs`, a file is unknown once a redirection or a spec's write
  may have reached it. A program that writes files no spec describes (a build script, `git checkout`) can still change
  a hook or put a symlink in place before a later command reads it.
- **Code that runs later is walked twice.** Trap actions, prompt strings and `PROMPT_COMMAND` are walked with the
  variables, functions and aliases of the moment they're set, and again with those at the end of the script and of
  the shell that set them (a subshell, `bash -c`). A definition that's replaced before the end, while the code may run
  in between (an `ERR` trap), is only seen if it was there when the code was set.
- Dynamic arithmetic values are findings unless the analyzer can establish they are numeric. Static values are
  recursively followed in arithmetic commands, expansions, loops, `let`, integer tests, array indices, substring
  offsets and integer declarations.
- An aliased command with a here-document is parsed again without the document's body: a parse error, which asks.
- unbash rejects some redirection targets Bash accepts, an empty `$''` (`cat > $''`) and a here-string that is a
  process substitution (`cat <<< <(f)`): a parse error, which asks.
- Paths: `~` is only a real directory when `$HOME` is known. Symlinks are resolved only with `fs` and an absolute
  working directory.
- The walk has a work budget. A script past it gets a `too-deep` finding rather than a full analysis.
