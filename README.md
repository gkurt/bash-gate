# bash-gate

Static analysis of Bash commands: every program a command line may run, with its subcommands, options, paths and
effects, and a policy that allows, asks about or denies it. Built for gating the commands an AI agent runs, but the
analysis stands on its own: highlighting, auditing, explaining commands.

Prototype. Parsing is [unbash](https://github.com/webpro-nl/unbash); everything else is here. The analysis runs
anywhere JavaScript does: no Node APIs, no native code. [`bash-gate/trace`](#running-under-the-supervisor) runs the
command and holds it to the analysis, on Linux. [The site](https://gkurt.com/bash-gate/) runs it live, and
[the tutorial](https://gkurt.com/bash-gate/tutorial.html) walks through it a lesson at a time.

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

1. **Parse** with unbash. Any parse error, nested ones included, is a finding, so the command can't be allowed. So is
   a carriage return in code, which Git Bash on Windows drops and Bash on Linux keeps.
2. **Resolve words** (`src/words.ts`): quotes and escapes removed, braces expanded, known variables substituted, unquoted
   expansions split. A word is either static strings or one dynamic argument that says why (`variable`, `glob`,
   `substitution`…) and whether it may become several words.
3. **Walk with shell state** (`src/analyze.ts`): variables (constant propagation, joined across branches, loops walked
   until they settle, with what holds at each `break`, `continue` and `return`), functions, aliases, `hash -p`, `enable -n/-f`, `cd`, exports into child shells. Aliases expand
   as Bash parses: with `expand_aliases`, POSIX mode, `sh` or an interactive shell, from the next line, and in a
   function body as they were when it was defined. Entering POSIX mode turns `expand_aliases` on and leaving turns it
   off. In POSIX mode a substitution has the aliases of the line it was parsed with, and one Bash only parses as it
   runs (in a here-document, or text expanded again) gets none. Subshells, pipelines and substitutions get copies of the state.
   Variables Bash gives a meaning of its own are state too: assigning `BASH_ALIASES` or `BASH_CMDS` makes the alias or
   `hash` table unknown, and one Bash sets as it runs (`RANDOM`, `PWD`, `PIPESTATUS`, `_`…) is unknown whatever was
   assigned. Every way to assign counts (`${x:=v}`, `printf -v`, `read`, `wait -p`, `exec {fd}>`, `coproc`, `select`),
   and so does `unset`, which removes a function when no variable has the name. Assigning or unsetting a variable named
   only at run time, or a nameref (`declare -n`), may change any variable: every value, both tables and `PS4` become
   unknown. A name a builtin reads (`read`, `printf -v`, `unset`, `test -v`, `declare`, what `${!x}` refers to) or a
   value evaluated as arithmetic may have a subscript, which Bash expands: its substitutions are walked, and one only
   known at run time is code unseen. A command Bash can't find runs `command_not_found_handle` if one is defined, so it's walked in place of
   each program. An assignment before a function or builtin is a variable while it runs, and a `local` of the same name
   starts with its value.
   Shell options that change what runs are state as well, from `set`, `shopt` and a child shell's own options (`+O`
   too), and passed on to it when BASHOPTS or SHELLOPTS is exported: `lastpipe` keeps what a pipeline's last command
   changes (unless `set -m`), `localvar_inherit` gives a local its outer value, `allexport` exports what's assigned or
   defined, `local -` puts the `set` options back when the function returns, and under `set -P` or `cd -P` the
   directory is where symlinks lead, which only the files say (`cdable_vars`: nothing can say). A `cd` fails on a
   directory that isn't there and the shell stays, so the working directory is only known after it where the status
   says it succeeded (`cd a && …`, `if cd a; then …`), or failed (`cd a || …`). Those whose effect
   isn't followed are `unknown-syntax` findings: a compatibility level (`compat31`…, `BASH_COMPAT`), `set -k` and
   `set +B`. The rest only make Bash run less, matter only interactively, or change globs, which are unknown anyway.
4. **Dispatch** as Bash does: alias, then function, then builtin, then program. `command`, `builtin` and `exec` change
   that order, and `jobs -x` runs its words as a command. `eval`, `trap`, `mapfile -C`, `compgen -C`, `bash -c`, a shell's here-document or here-string, `ssh host
   cmd`, `watch`, git aliases, git config commands, gh aliases and config, prompt strings (`PS4`, `${x@P}`, with `\n` and
   octal escapes decoded first, and one whose value is only known at run time, such as `\s`, a finding) and `PROMPT_COMMAND` parse their strings and walk them as code. Once set, a trap action or prompt string may run between any two commands (a signal, a failing command,
   `set -x`), so it's walked at each of those points with the state there, until `trap -` resets it, and what it
   changes carries on. Code for other shells (`zsh -c`, `fish -c`, `pwsh`) is never parsed as Bash: it's code the
   analysis can't see into, and so are command lines run again from the history (`fc`, or history expansion turned
   on with `set -H`).
5. **Read argv with a spec** (`src/specs.ts`, `src/argv.ts`): options under canonical names (`-f`, `--forc`, `-fu` →
   `--force`), clusters, attached values, `--`, POSIX vs GNU ordering, subcommands, paths read and written, and the
   command lines that wrappers run (`sudo`, `env`, `timeout`, `xargs`, `find -exec`, `git bisect run`…). `gh` is read
   as cobra reads it: a flag before a subcommand takes the next word unless it's a known boolean, so
   `gh -R o/r pr merge` is `pr merge`, and a first word gh doesn't know is an alias or extension (`exec:arbitrary`).
   The words `xargs` appends are read with the rest: `xargs env` runs them as a command, `xargs tee` writes them. A
   word that may be several, or an option, before a wrapper's command (`timeout $x`, `nice -n $x`) leaves the command
   unknown. A `sed` script is read command by command, for the commands it runs and the files it names. A package
   manager's word is a script by the rules of each: `pnpm lint` and `bun run lint` run a command from PATH when no
   script has that name (`pnpm node -e …`), `bun lint` a file (`lint.ts`), and a word npm doesn't know is the start of
   one of its commands' names (`npm exe` is `npm exec`). An option npm, pnpm or bun doesn't know is configuration,
   which may name the shell scripts run in: `exec:arbitrary`. So is `npm config set`.
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
    ask({ writes: ['..', '../**'] }),
  ],
};
```

- `command`: the program, then subcommands, alternatives after `|`, and `*` for any.
- `options`: any of these options is given, spelled however the spec allows.
- `args`, `writes` and `outputs`: globs matched against paths (`writes`: every file it writes, its redirections included;
  `outputs`: only those its own arguments name, as `sort -o x` does), as written, as resolved against the tracked working directory, and
  as their real path when the analysis had a filesystem (see below). Deny and ask rules match any path form, and may
  match a path whose real path isn't known. Allow rules must match a known path form and, with a filesystem, the real
  path, so they never match a path whose real path can't be known. They don't match a path as written, since after a
  `cd` it names another place (`cd /tmp && echo x > src/a`); a non-path positional fails them once the script leaves
  where it started. When `$HOME` is known (set in the script, or given
  in `env`), `~` globs match absolute paths under it, and the other way round. Another user's home (`~root`) may be
  anywhere. Relative globs (`src/**`, `../**`) also match paths from where the script starts, when `cwd` was given as
  an absolute path (and from its real path, with a filesystem). Without it, an absolute path may be anywhere against
  the start, so it may match a deny or ask rule's relative glob. Deny and ask rules also match `.git` and `HEAD` in any
  case, and `.git`'s Windows short name `GIT~1`, as a filesystem that ignores case takes them.
- `effects`: `fs:read`, `fs:write`, `fs:delete`, `network`, `network:read`, `privilege`, `exec:arbitrary`,
  `exec:project`, `exec:file`, `exec:remote`, `exec:nested`, `shell-state`, `secrets:read`, `secrets:print`. `exec:nested` is git
  looking into repositories nested in its work tree that the analysis couldn't look for (see the filesystem below);
  `recommended` allows it. `secrets:read` reads what is likely a
  secret: the environment as a whole (`printenv`, `env` or `export -p` alone, `declare -p`, `local -p`, `set` alone,
  `ps e` anywhere in its arguments, `ps -E`, awk's `ENVIRON` (gawk's `SYMTAB` and `PROCINFO` too, and `ARGV`, which may name any file), jq's `env`, `$ENV` and `import` (in gh's `--jq` too), yq's `env()`,
  `strenv()` and `load…()`), a file that holds credentials, read, sourced, redirected, renamed (`mv`, `ln`), matched by
  a glob (`.e?v`, `~/.aws/*`, `~/*/credentials` under `dotglob` or `GLOBIGNORE`), listed by `git config --file` or at
  a git revision (`git show HEAD:.env`), but not only named (`git ls-files .env`, `git status .env`) or written (`cp
  .env.example .env`) (`.env` and its variants but templates like `.env.example`, `.envrc`,
  `.dev.vars`, SSH private keys, `*.pem`, `*.key`, `*.ppk`, `*.kdbx`, `.netrc`, `.npmrc`, `.my.cnf`, `.htpasswd`,
  `~/.aws/credentials`, any file in `~/.kube`, gcloud and Azure credentials, git's, agents', registries' and cloud
  CLIs' credentials files, `*.tfstate`, `*.tfvars`, `/proc/*/environ`; a directory holding them read recursively; and a
  name only known at run time, from a substitution, input, a variable or an argument, unless its known end rules a
  secret out: `cat "$f"`, `cat $(…)`, `xargs cat`, `find -exec cat {}`, but not `cat "$name.ts"` or a loop's file from a
  static glob that matches none, `for f in src/*.ts`), a variable that may hold one expanded anywhere
  (an upper-case name with a word ending in `TOKEN`, `SECRET`, `PASSWORD`, `PASSPHRASE`, `CREDENTIALS` or `APIKEY`, a
  word `PWD`, `PAT` or `SSHPASS`, or ending in `KEY`: `$GITHUB_TOKEN`, `$PGPASSWORD`, `$OPENAI_API_KEY`, but not one
  ending in `DIR`, `FILE` or `PATH`, or with a word `PUBLIC`, `MAX`, `MIN`, `NUM`, `COUNT`, `LIMIT` or `BUDGET`; a
  nameref; `${!x}` naming one), in a command, an assignment, a loop's words, a prompt string (`PS4`, `${x@P}`) or
  arithmetic (`$(( ))`, a subscript, an offset, `[[ X -eq 0 ]]`, an integer variable's value, and a variable whose
  value names one), but only tested (`[ … ]` with one word, a unary test or a string comparison, `[[ ]]`, `case`; not
  `test`, which leaves its last word in `$_`; not as a number and not under `set -x`), and what a tool prints of its own (`kubectl get secret -o yaml`, any kubectl command printing a Secret
  with `-o` or `-v=8` and up, `kubectl config view`, `helm get values`, `helm status -o json`, a helm dry run with
  `--reuse-values` or `=server` unless `--hide-secret`, `terraform output
  -json`, `terraform state pull`). A file named only by a word known at run time (`cat
  "$f"`), or read by a recursive search (`grep -r`), isn't known to be one. `network:read` only reads, from a host already set up:
  `git fetch` and `git ls-remote` from a remote given by its name (or none), and the `gh` commands that look
  (`gh pr view`, `gh run list`, `gh search`). They have `network` instead once the command line may say where to go:
  a URL or a path, `git -c`, `--git-dir`, `gh -R HOST/OWNER/REPO`, `--web`, an argument only known at run time, or an
  option the spec doesn't know. A rule naming `network` doesn't match `network:read`: name both to cover both.
- `secrets:print` is `secrets:read` where the secret reaches the script's output whole: the invocation that reads it
  copies what it reads unchanged (a spec's `copies`: `cat`, `tac`, `head`, `tail`, `less`, `more`, `bat`, `nl`,
  `strings`, `xxd`, `od`, `hexdump`, `base64`, `rev`, `sort`, `uniq`, `paste`, `join`, `diff`, `comm`, `zcat`, `dd`
  without `of=`, `tee`; `cp` onto `/dev/stdout`; `git show`, `cat-file` and `diff`; `echo` and `printf` of a secret
  variable, but not `printf -v`), prints the environment (`printenv`, `env` with no command, `export -p`, `set`,
  `declare -p`), is a tool printing a secret of its own (`kubectl get secret -o yaml`, `terraform output -json`, `helm
  get values`), or runs under `set -x`, which traces what it expands. A secret travels through what holds it: a
  variable assigned it, read into or looped over (`t=$GITHUB_TOKEN; echo "$t"`, `read l < .env; echo "$l"`), and a
  substitution that read it (`echo "$(cat .env)"`); only its length or a part of it (`${#GITHUB_TOKEN}`, `${x:0:4}`,
  `${x//?/*}`) isn't printed whole. And its standard output isn't redirected to a file (`> f`, `&> f`, `>/dev/null`,
  closed; replayed in order, so `2>&1 > f` and `> f 2>&1` both leave the file), piped only into programs known not to
  copy it whole (`| wc -l`, `| grep -c`, `| read`; a copying program, a wrapper running one, a function, a loop, a group
  or a program the analysis doesn't know pass it on, and a `tee` mid-pipe onto `/dev/stderr` prints it), or captured
  (`$(…)`, `<(…)`, a group or function call redirected), unless it's sent back to the output on purpose (`>&2`, `>&3`,
  `/dev/tty`, `/proc/self/fd/1`, `> >(cat)`). `cat .env` and `cat .env || true` print; `cat .env > /tmp/x`, `cat .env
  | wc -l`, `source .env && deploy`, `curl -H "Authorization: Bearer $GITHUB_TOKEN" …`, `docker run --env-file .env
  app`, `cp .env .env.bak` and `cut -d= -f1 .env` (which transforms what it reads: names only) read but don't print.
  `grep KEY .env` prints the lines it matches, and `sed`, `awk` and `jq` print when their script may pass a line or
  value through whole (`sed 's/^export //'`, `awk '{print $2}'`, `jq .token`), not when it can't (`awk '{print
  length}'`, `jq length`, `sed -i`).
- A dry run's `effects` are the rehearsal's, the same way in every spec that knows one: it still reads and may still run
  project code (`npm publish --dry-run` runs its lifecycle scripts, which are walked), but doesn't write (save what an
  option of its own names: a log, a plan file), delete or run anything remotely, and `network` becomes `network:read`,
  unless it still reaches a host the command names (`rsync -n src/ host:/dst`, `kubectl apply -f https://…
  --dry-run=client`) or may still push (`gh pr create --dry-run`). So a policy lets a dry run through on its effects
  without knowing about dry runs, though a rule on options still matches (`recommended` denies `git push --dry-run
  --force`). A value that turns it off (`--dry-run=false`, `=none`, `=0`), or one only known at run time, is no dry run,
  and neither is a command with an option the spec doesn't know, or a word that may be one: it may take the dry-run
  option as its value (`kubectl run --detach-keys --dry-run=client`), a plugin or a subcommand the spec doesn't know,
  or a command whose words without the option would read as another (`git clean -n -fen -x`, where one `n` is `-e`'s
  value). A `kubectl --raw` request ignores the dry run, and so do npm's commands but those that change the
  installation, pack or publish (`npm --dry-run run deploy`, `npm --dry-run dist-tag add` and `version` run for real).
  `git fetch --dry-run` and helm's `--dependency-update` still write (objects in `.git`, the chart's dependencies).
  `invocation.dryRun` is the real command it rehearses: `{ text, shape, effects }`, the effects that command would have,
  so a caller can match a later real run by shape and arguments as evidence it was rehearsed. Most are the same command
  without the option: `git push -n`, `git add|rm|mv|fetch -n`, `rsync -n`, `npm install|ci|update|uninstall|dedupe|prune|link|pack|publish|unpublish --dry-run`, `cargo publish
  --dry-run`, `gh pr create --dry-run`, `gh extension upgrade --dry-run`, kubectl's `--dry-run=client|server`, helm's
  `--dry-run` and `terraform state mv|rm -dry-run`. `git clean -n` stands for `git clean -f` with the same arguments,
  since git cleans nothing without `-f` while `clean.requireForce` has its default, true (`-f` or `-i` given are kept).
  `terraform plan` stands for `terraform apply` with the same arguments but those only a plan takes (`-out`,
  `-generate-config-out`, `-detailed-exitcode`).

  ```ts
  analyze('terraform -chdir=infra plan -out tfplan -var x=1').invocations[0].dryRun;
  // { text: 'terraform -chdir=infra apply -var x=1', shape: 'terraform apply --var=<v>', effects: ['exec:project', 'network'] }
  ```

- An allow rule never applies to a program given by a non-system path (`./ls`).
- Findings (`parse-error`, `dynamic-command`, `dynamic-script`, `dynamic-arithmetic`, `sensitive-variable`,
  `exec-config`, `loads-code`, `unknown-alias`, `too-deep`, `unknown-syntax`, `unknown-file`, `project-file`) ask unless
  `policy.findings` says otherwise. `recommended` allows `project-file`: a file only project code it runs may have
  changed before it's read.

`matchRule(rule, invocation, analysis)` matches one rule against one invocation outside a policy: 0 no, 1 maybe (a
dynamic word could make it match), 2 yes, read the cautious way for the rule's decision. A gate that maps invocations to
actions of its own, rather than to allow, ask and deny, matches them with it:

```ts
import { analyze, deny, matchRule } from 'bash-gate';

const analysis = analyze('sudo gh -R o/r pr merge 12', { cwd: '/repo' });
analysis.invocations.some((invocation) => matchRule(deny('gh pr merge'), invocation, analysis) === 2); // true
```

`recommended` (`src/recommended.ts`) is a starting point. It allows reading and everyday git, denies force pushes and
deleting top-level directories, and asks about deleting, network, privilege, code it can't see, writes outside the
working directory (`..` and `../**`, `~` among them: a path counts as outside unless an absolute `cwd` shows it's inside, so a project under `~` is still the project; a `cwd` that isn't a POSIX absolute path, such as `C:/w/p`, places nothing), writes
to the system's programs, libraries and configuration (`/usr`, `/bin`, `/lib`, `/etc`, `/boot`, `/opt`, `/var/spool`, `/run/systemd`, macOS's `/private/etc`, even from a script started at `/`), writes
to any dotfile or dot directory in `~` (shell startup files, `~/.ssh`, `~/.config`, `~/.local`, editors' plugins, version managers' shims) and to `~/bin` and `~/go/bin` (even from a script started in `~`, in any case, by a Windows short name, and through a symlink, where HOME really is or where it was when the script started), writes inside a `.git`, writes to the agent's project settings (`.claude/`, `.mcp.json`), and writes to a file named `HEAD` (with `objects` and `refs` beside it, git takes any directory as a
repository). It asks about git forms that discard uncommitted work or move a ref (`reset --hard`, `branch -f`,
`checkout -B`, `switch -C`, `switch -m`, `checkout -f`, `checkout -- <path>`, `checkout <word>` when, with files, a file or
directory has that name and no ref does, `rebase --onto`, `merge`, `rebase` or `cherry-pick` `--abort` and `--skip`, `stash export --to-ref`, `restore` of the work tree, `fetch --stdin`), and about those that open the editor, which may read commands from the script's input (`commit` without a message, `tag -a` without one, `rebase -i`, `--edit`, `--continue`) and denies those that rewrite or delete remote
history (`push --force`, `--delete`, `--mirror`, `--prune`). `sed` and `awk` run when their script only edits what they read
(`sed -n '1,40p'`, `awk '{print $1}'`): one that runs a command, writes a file, edits in place or isn't followed asks.
Of the network, `network:read` runs: `git fetch`, `git ls-remote`, and gh's commands that look at pull requests,
issues, runs, releases, repositories and search. A fetch that forces or deletes local refs asks, and so do `git pull`,
`git remote add` and `set-url` (they write `.git/config`), `gh api`, and a proxy, `GH_HOST` or `GH_REPO` set on the
command line (sensitive variables). It asks about reading secrets (`secrets:read`).
`kubectl` and `helm` run when they only read the cluster and the chart repositories their config already names
(`kubectl get`, `logs`, `describe`, `diff`, a `--dry-run`, `helm list`, `status`, `template`), and ask when they change
it (`network`: `apply`, `delete`, `install`, `upgrade`, and a `--dry-run` Go reads as false, `=false` or `=0`), run
something in a container (`exec:remote`: `kubectl exec`, `run`, `debug`, `cp`), open an editor, run a plugin (a word
they don't know), print a Secret, change the user's kubeconfig or helm config, or go to a server, kubeconfig, chart
URL, repository file or cache of their own (`--repository-config`, `--repository-cache`, `XDG_CACHE_HOME`), a URL in a
comma-separated `-f`, or a kustomization a host names (`github.com/org/repo`, `deploy@host:repo`). An option their spec
doesn't know, or a word that may be one (`$FLAGS`), is `network`, as gh's is: it may name a host, or take the next
word as its value. `helm repo index`
and `dependency build|update` write into the directory they're given.
`terraform init`, `validate`, `plan`, `fmt` and the state commands that only list run: they run the project's
providers and `external` data sources as project code (`exec:project`). `apply`, `destroy`, `import`, `test`, the
state changes and `login` ask, and so do `init -migrate-state`, `-force-copy` or a `-backend-config=KEY=VALUE`,
`providers lock -net-mirror`, `workspace select -or-create`, `fmt -check=false` outside the project, and `output -json`, `output NAME`, `show
-json`, `state pull`, `state show` and `console`, which print secrets.
It allows project code (`exec:project`) as it does git hooks: the scripts, tests and builds `npm`, `pnpm`, `bun` and
`cargo` run (`npm test`, `bun typecheck`, `cargo build`), and the tools those scripts run (`tsc`, `biome`, `oxlint`,
`oxfmt`, `eslint`, `prettier`, `vitest`, `jest`, `tsdown`, `vite`), unless they also install, publish, delete, write
outside the working directory, or run code the analysis can't place. cargo's builds and bun's runs may fetch the
dependencies they haven't got (`network:read`, which runs). Project code is the project's where the script starts, at
its real path: another directory's scripts, hooks or tests (`cd .. && npm test`, `bun test /tmp/x.test.ts`, `cd
link` to elsewhere), another workspace or package (`npm -w ../b test`, `pnpm --filter`, `cargo test -p b`), or project
code run after git rewrote the work tree, are `exec:file` and ask. A redirection to Bash's `/dev/tcp` or `/dev/udp` is
`network`. Without `fs`, a name `pnpm` or `bun run` may run from PATH asks, since no script may have it, and so do words
after a script's name (`npm test -- --config x`), which are appended to a script the analysis can't see.
`make` isn't followed and asks. Add an ask rule for `exec:project` if project code matters.

## The environment

`analyze` and `check` take an optional `Environment`: the starting `cwd` (absolute), the variables in `env`, `maxDepth`,
and `fs`, the filesystem as it is before the command runs. `check` needs everything in it to answer at once, and
`checkAsync` takes promises too; the library uses no Node filesystem APIs, so it works wherever JavaScript does.

The answers hold only if nothing else writes before the run ends. Run commands one at a time, and don't start the next
while anything the last one started is still running: a job it left in the background (`make &`, `nohup`,
`setsid -f`) could rewrite a hook or `.git/config` after the next command was checked. `bash-gate/trace` waits for, or
kills, the whole process tree.

`fs` takes the shape of [just-bash](https://github.com/vercel-labs/just-bash)'s `IFileSystem` and of Node's `fs`, so
either can be passed as it is. Every method is optional, and each may answer at once or with a promise:

```ts
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { check, recommended, type FileSystem } from 'bash-gate';

const fs: FileSystem = {
  readFile: readFileSync,
  readFileBuffer: readFileSync,
  readdir: readdirSync,
  realpath: realpathSync,
  lstat: lstatSync,
};
check('git commit -m wip', recommended, { cwd: process.cwd(), fs });
```

With `fs`, Git repository config (including `include.path`, `config.worktree` and `.git` pointer files), the Git hooks
a command runs, SSH config files passed with `-F`, and the package.json scripts npm, pnpm and bun run (with their `pre` and `post`
scripts) are read and walked as code, and each
invocation gets the `realpaths` of its paths. `make` remains `exec:project`; Makefiles aren't parsed.

The hooks are each command's own (`pre-commit`, `post-checkout`, `pre-push`…), plus `post-index-change` and
`reference-transaction` for every command: git runs those whenever it writes the index (`git status` does) or a ref.
They're read from `core.hooksPath` when the repository's config sets it, as husky does, so `git status` there is
judged like anywhere else, and `git commit` by what its hook runs. husky's stub sources its dispatcher by a computed
path, so a hook that is exactly what husky 7, 8 or 9 writes is followed to the project's own hook in `.husky`,
without the line older versions put at its top: `.husky/pre-commit` is what's judged, and with none, nothing runs.
A husky file changed by hand is walked as it is, which asks. Where git would look isn't always certain (a relative path with `--git-dir` or `--work-tree`, `~` without a
known `HOME`, a path set in a conditional include): that's an `exec-config` finding.

- `readFile(path, 'utf8')` is a file's text, `readFileBuffer(path)` its bytes, `readdir(path)` the names in a
  directory, and `realpath(path)` where an absolute path really is. Nothing there is `null` or an error whose `code`
  (Node) or message (just-bash) starts `ENOENT`, `ENOTDIR` or `EISDIR`; other errors propagate. Where `realpath` finds
  nothing, `lstat(path)` tells a dangling symlink, where a write would land is unknown, from nothing at all, whose
  parent is tried instead, so files that don't exist yet have a real path. Without `lstat`, that isn't known.
- What isn't known, a missing method or `undefined`, becomes an `unknown-file` finding, and an entry in
  `analysis.needs` for a method the filesystem has: `{ kind: 'file' | 'bytes' | 'realpath' | 'directory', path }`.
  `check` needs answers at once, and throws a `TypeError` on a promise; `checkAsync` takes either.
- git looks into every repository its index records as a gitlink, `.gitmodules` or not: `git status` runs its
  `core.fsmonitor`. They're read from `.git/index` with `readFileBuffer` (versions 2 to 4; not a split or sparse
  index). A command that checks out another commit (`checkout`, `switch`, `reset`, `merge`, `stash`…) looks into
  those of that commit at any path, and so does a command after git may have changed the index (`git add -A && git
  status`): then every repository in the work tree is followed, found with `readdir` (symlinks aren't descended into,
  as git doesn't). One the script may have put there before (`cp -r`, a write into a `.git`) is an `unknown-file`
  finding. The gitlinks are looked for in the work tree `--work-tree` names, or with `--git-dir`, where git runs. The
  git directories of submodules under `.git/modules` are followed too, checked out or not, since `git fetch` and a
  recursive checkout use them; listing them takes `readdir`. Where neither can be done (no `readFileBuffer`, no `readdir`, or a tree of more than 50,000 directories),
  the git invocation has the effect `exec:nested`, which `recommended` allows: a gate that wants it known asks for it.
- The answers are about the filesystem _before_ the command. A file the script may write before it's read
  (`cp -r hooks .git/ && git commit`), or while it's read, is an `unknown-file` finding. While it's read is what the
  other commands of a pipeline write (`./build.sh | git commit`), and with `&` or `<(…)` anything the script writes
  after; a command's own writes after its read don't count (`npm test | tail`).
  A write may go through a symlink, so without an absolute `cwd` any write makes later reads unknown. A path under one
  the script may put a symlink on (`ln`, `cp`, `mv`, `tar`…) has no known real path. `mkdir`, `touch` and `chmod` change nothing a read sees. Git commands
  that rewrite the work tree (`checkout`, `stash`, `reset`, `merge`…) change everything in it but its `.git`, whatever
  they check out: `HEAD`, the index and a stash hold what an earlier command may have committed, staged or stashed. A
  file read after them (a hook in `.husky`, a package.json) is unknown, and so are its real paths, since a commit may
  hold a symlink. A program
  that may write files no one can name makes every later read unknown: one without a spec, one running code the
  analysis doesn't follow (`make`, `npm install`, `vitest`, `python3 -c`, `./build.sh`), or one whose spec writes
  without saying where. When the only such program is project code (`exec:project`: a test run, a build, a hook it
  doesn't follow), what it may have changed is a `project-file` finding instead, what was there is still walked, and
  real paths stay as they were: a
  policy that runs project code gains nothing by asking about what that code could have done itself. `tsc` writes only what it emits (`.js`, `.d.ts`, `.map`, `.tsbuildinfo`), and `biome` only the
  kinds of file it formats, so after them only files of those kinds are unknown, wherever they are, along with a file
  named for them to write (`tsc --outFile`). `tsc` copies the JSON its sources import into its output, from wherever
  it is, so after it every `.json` is unknown too, a package.json included (`tsc --noEmit` writes nothing).

`snapshot({ files, realpaths, directories, buffers })` builds a `FileSystem` from records: a path in none isn't known,
and a record not given is a method it doesn't have. Where the filesystem is only reachable asynchronously (a browser, a
remote sandbox, just-bash), `checkAsync` analyses with what it has, fetches the needs, and goes again:

```ts
import { checkAsync, recommended } from 'bash-gate';
import { OverlayFs } from 'just-bash/fs/overlay-fs';

const overlay = new OverlayFs({ root: '/path/to/project' });
const cwd = overlay.getMountPoint();
const verdict = await checkAsync('git commit -m wip', recommended, { cwd, fs: overlay }, { rounds: 8 });
```

Only content that names the next file costs a round: finding `.git` above a directory takes one, its hooks and
includes another, and listing the work tree one for each level of directories in it. Needs left after the last round stay findings, so the command asks.

## Running under the supervisor

Static analysis can be wrong. `bash-gate/trace` runs the command with every exec in its process tree stopped, and
checks each one against the analysis, so a gap in it is a refused command rather than an escape:

```ts
import { analyze } from 'bash-gate';
import { run } from 'bash-gate/trace';

const result = await run('ls; cat secret', { analysis: analyze('ls'), cwd: '/repo' });
result.stderr; // 'bash: line 1: /usr/bin/cat: Operation not permitted'
result.execs; // [{ path: '/usr/bin/ls', argv: ['ls'], via: [], covered: true, refused: false }, { …, refused: true }]
```

- It runs `bash --noprofile --norc -c <source>` in `cwd`, with exactly `env` (by default a `PATH` of system
  directories), and resolves with the exit code, the output, and every exec once every process has exited, daemons
  included (`setsid -f`, `nohup … &`), so nothing it started outlives it. `timeout` kills the whole tree. The analysis defaults to `analyze(source, options)`; pass the one you checked, so the run is
  held to what the policy saw.
- `mode: 'enforce'` (the default) fails an exec the analysis doesn't cover with EPERM before it runs: the program and
  its arguments, the file it runs (the path the invocation gave, or a directory of the run's `PATH` for a name), and
  the name it's started under (`exec -a`), which some programs act on. `mode: 'trace'`
  lets it run and marks it `covered: false`: an oracle for tests, fuzzing and red teams.
- **What's checked** is what the shell starts, and what a wrapper it follows starts (`env`, `xargs`, `find -exec`,
  `timeout`, `nice`…), against the invocations under that wrapper. A program the analysis doesn't follow
  inside (`git`, `make`, `npm`, `python3`, a script file) runs its own children unchecked (`via: null`): what it does
  is its behaviour, judged by the policy when it was asked about. `covers(analysis, argv, via)` in the main entry is
  the same check.
- A finding that hides code (`eval "$x"`, a dynamic command, an alias whose text is only known at run time) covers
  anything, as in S1: the policy asked about it.
- An invocation whose file isn't known (`invocation.unplaced`: `exec -a`, a name `hash -p` gave a path only known at
  run time, a git hook the analysis can't read) covers any program, from anywhere, with its arguments. That one
  invocation only: the other commands in the same `bash -c` string or under the same wrapper are checked as usual.
- While an exec is checked, every other process and thread in the tree is stopped, until the kernel has copied its
  arguments or failed it: nothing in the tree can change what it runs after the check. A clone with `CLONE_UNTRACED`,
  whose child nothing would stop or wait for, fails with EPERM. So do a new user or mount namespace, `chroot`, `mount`
  and `setns`, which would change what a path names, or give a process capabilities over the others (`unshare -r`).
- A relative path is the file it reaches from where the process really is, and a path with `..` after a name, or under
  `/proc`, is never the file predicted (a symlink, or `/proc/self/cwd`, leads the kernel elsewhere); the run's Bash is the system's, whatever
  `PATH` finds first; and the shell a wrapper runs code through must be running the code the wrapper was given.
- No process in the tree holds `CAP_SYS_PTRACE`, root included. Tools that read other users' processes as root
  (`lsof`) see less.
- The supervisor (`src/trace/supervisor.c`) is built with the system's C compiler (`$CC`, else `cc`) into
  `~/.cache/bash-gate` on first use, or ahead of time with `buildSupervisor(directory)` and passed as `supervisor`.
  x86_64 Linux only.
- Under the supervisor nothing gains privileges: `sudo` and other setuid programs fail. Programs that stop themselves
  (`SIGSTOP`, `SIGTSTP`) carry on instead. i386 and x32 programs can't exec.

## Tests

```sh
bun run checks   # tsc, then bun test
```

- `test/escapes.test.ts`: about 200 commands and the decision `recommended` must reach. They cover quoting, braces,
  variables, substitutions in odd places, wrappers, strings run as code, functions, aliases, `hash -p`, loops, prompt
  strings, `~` paths, other shells, git refspecs and config, gh. A few more run with a filesystem: hooks walked, and
  written before or while git reads them.
- `test/analyze.test.ts`: word resolution, option parsing, shapes, spans and state; with a filesystem, which reads and
  real paths the script's writes make unknown, needs, and `checkAsync`.
- `test/metamorphic.test.ts`: generated chains of equivalent rewrites of denied and asked commands, plus rewrites that
  hide values, checked under strict and non-strict policies. Set `METAMORPHIC_RUNS` to change the number of cases.
- `test/bash.test.ts`: runs scripts (the hand-written ones are in `test/scripts.ts`, the generator in `test/generated.ts`) in real Bash with a `PATH` of
  logging stubs. Every program that ran must be one
  the analysis predicted, with those arguments, in the directory it predicted, or one a finding hides (the `hiding`
  scripts and mutants). Every file the shell wrote must be one the analysis says it writes. Generated scripts with a
  finding that leaves code unseen are skipped, since nothing they run could fail the check.
  This is the check that keeps the analysis honest. Extend it before trusting a new construct. Besides the
  hand-written scripts, it generates scripts that mix variables, functions,
  aliases, `hash -p`, loops (`break`, `continue`, `return`), `case` fallthrough, `cd`, here-documents, substitutions,
  `eval`, `bash -c` and traps over a few shared names, along with namerefs,
  `unset`, `command_not_found_handle`, `BASH_ALIASES`, `BASH_CMDS`, variables Bash sets itself, names with subscripts
  that builtins read, and values Bash may read as code (a subscript, a prompt string), under shell options
  (`lastpipe`, `localvar_inherit`, `allexport`, POSIX mode, exported BASHOPTS and SHELLOPTS). Set `BASH_RUNS` to
  change the number of generated scripts.
  The generator only writes what the analysis already follows, so the parser is fuzzed apart from it: mutants
  (`test/mutated.ts`) of the hand-written and generated scripts, changed a few characters or tokens at a time
  (quotes, `$'…'`, here-documents and their delimiters, case patterns, extglob, comments, line continuations, lines
  of other scripts). Any the analysis claims to see through, with no finding that leaves code unseen, runs in Bash,
  and everything it starts must be covered. Mutants may loop forever: each runs in a process group that's killed
  after a few seconds. Set `MUTATION_RUNS` to change their number. A failure prints fast-check's seed and path:
  `FUZZ_SEED=<seed> FUZZ_PATH=<path> bun test test/bash.test.ts -t 'generated scripts'` replays it.
  The specs are fuzzed against the programs they describe (`test/wrapped.ts`): the wrappers the machine has (`env`,
  `nice`, `nohup`, `timeout`, `stdbuf`, `xargs`, `find -exec`, `setsid`, `flock`, `ionice`, `taskset`) run for real
  around the stubs, nested, with options spelled every way getopt reads them. What each starts, and under which
  wrappers, must be what the spec predicts. Set `WRAPPED_RUNS` to change their number.
- `test/trace.test.ts`: on x86_64 Linux with a C compiler, the hand-written, generated and wrapped scripts again, with
  real programs under the supervisor: every exec the kernel sees, by any path, must be covered. Plus what enforcement
  refuses and what it leaves to the programs it doesn't follow. Set `TRACE_RUNS` to change the number of generated
  scripts.

## Known gaps

- **Program specs are intentionally conservative.** The listed `sed`, `awk`, `tar`, `rsync`, `vim`, `zip`, `ssh`,
  output-file and command-wrapper forms are flagged or followed where their arguments identify code or paths. Some
  language-specific snippets are effect findings rather than fully interpreted programs, and other programs remain
  unspecified. A `sed` script is followed only in the forms every sed reads alike: text for `a`, `i` and `c`, a
  delimiter inside a bracket expression, or an option the spec doesn't know make it `exec:arbitrary`. An `awk` program
  is searched as text for what it needs to run a command or write a file (`system`, `|`, `getline`, `@`, a `>` after
  a `print`), strings included, so `awk '/a|b/'` asks. `less` and `more` are not on the recommended read allowlist because their command modes can run code.
- **Project code depends on the integration.** With `fs`, git's config and hooks are read from the repository git
  takes: the one `--git-dir` or `--bare` names, else the first from the working directory up, in a `.git` or in a
  directory that has what a `.git` has. Without `fs`, package scripts, Git hooks and config cannot be followed; commands
  remain `exec:project`, and the recommended policy asks about writes inside a `.git` and to a file named `HEAD`. That
  stops a repository made by hand, but not a copy of one under another name (`cp -r .git r`) whose config is then
  edited: only `fs` shows git reading it. `make` is `exec:project` and Makefiles aren't parsed. Package scripts are
  read from the package.json where the command runs, with the words after the script's name appended, and the
  scripts `npm pack` and `npm version` run are walked too, with the commit `npm version` makes (its hooks run): a workspace's (`--filter`, `-r`, `-w`) aren't followed, nor
  those bun runs in its own shell (`--shell=bun`), nor npm's and pnpm's when a `.npmrc` in the project or above it (read as npm's ini reads it) names another
  `script-shell` or picks workspaces, or pnpm's `pnpm-workspace.yaml` a `scriptShell` (that program is `exec:file`, or `exec:arbitrary` when it comes from the environment), and with no package.json there, one above it may be used, which is
  an `exec-config` finding. cargo's build scripts, aliases and `rustc-wrapper` are project code that isn't read.
- **`network:read` trusts the remote.** A fetch goes where the repository's config says, and tells that host which
  refs it asked for and which commits it has; gh's reads send their arguments (a search, a branch name) to the host gh
  is signed in to. Neither sends file contents, but both are a way to pass a few words to a host that was set up
  before the command ran. So are kubectl's and helm's reads, and `terraform plan`, whose providers and data sources
  call whatever the project's configuration names, with the user's credentials.
- **`secrets:read` is known by name.** A file is a secret by its name or where it is, and a variable by its name: a
  secret in `config.json`, in a variable named `DB_URL`, read through a word only known at run time (`cat "$f"`,
  `xargs cat`, `find -exec cat {} +`), or by a recursive search or a bare `*` that happens to reach one, isn't one. A kubeconfig's and terraform's own credentials are used, not read, by the commands that reach a cluster
  or a provider.
- **What a specified program writes is what its spec says.** With `fs`, a file is unknown once a redirection, a spec's
  write, a work tree git rewrites, or a program that may write anything may have reached it. A program whose spec
  names some of its writes but misses others can still change a hook or put a symlink in place before a later command
  reads it.
- Dynamic arithmetic values are findings unless the analyzer can establish they are numeric. Static values are
  recursively followed in arithmetic commands, expansions, loops, `let`, integer tests, array indices, substring
  offsets and integer declarations.
- Paths: `~` is only a real directory when `$HOME` is known. Symlinks are resolved only with `fs` and an absolute
  working directory.
- The walk has a work budget. A script past it gets a `too-deep` finding rather than a full analysis.
- **The supervisor checks execs, not other effects.** A builtin's write (`echo x > f`) needs no exec, and what a
  program the analysis doesn't follow starts isn't checked. Such a program can still change an allowed exec's
  arguments after the check through memory the kernel writes on its own (`io_uring`, a process that shares the memory
  dying), but it could already run anything itself. So can a process outside the tree that may write its memory.
