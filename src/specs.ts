import { normalize, readCobra, type CommandSpec, type OptionSpec, type Parsed } from './argv.ts';
import type { Arg, Effect } from './types.ts';

/**
 * An option from its spellings, space-separated: a trailing `=` takes a value (`-n= --lines=`), `=?` an attached one
 * only (`--color=?`). The first long spelling is the canonical name, or the first spelling when there's none.
 */
function o(spellings: string, extra: Omit<OptionSpec, 'names' | 'value' | 'valued'> = {}): OptionSpec {
  let value: OptionSpec['value'];
  const valued: string[] = [];
  const names = spellings.split(' ').map((name) => {
    const suffix = /=\??$/.exec(name)?.[0];
    if (!suffix) return name;
    value = suffix === '=?' ? 'attached' : true;
    valued.push(name.slice(0, -suffix.length));
    return name.slice(0, -suffix.length);
  });
  names.sort((a, b) => Number(b.startsWith('--')) - Number(a.startsWith('--')));
  return {
    names,
    ...(value !== undefined ? { value } : {}),
    ...(value !== undefined && valued.length < names.length ? { valued } : {}),
    ...extra,
  };
}

/** Options from spellings, or from specs when they need more than spellings. */
function opts(...specs: (string | OptionSpec)[]): OptionSpec[] {
  return specs.map((spec) => (typeof spec === 'string' ? o(spec) : spec));
}

/**
 * Subcommands read alike, space-separated, each its own entry so a policy names it as itself (`git revert`, not
 * `git cherry-pick`). `|` joins aliases of one subcommand: `ls|list`.
 */
function each(names: string, spec: CommandSpec): Record<string, CommandSpec> {
  return Object.fromEntries(names.split(' ').map((name) => [name, spec]));
}

const staticValue = (arg: Arg | undefined) => (arg?.kind === 'static' ? arg.value : undefined);

/** A shell: `-c` runs its first positional as code, a positional alone runs that file, `-s` or nothing at all runs stdin. */
const shell: CommandSpec = {
  posix: true,
  options: opts(
    '-c',
    '-i',
    '-l --login',
    '-s',
    '-e',
    '-u',
    '-x',
    '-v',
    '-n',
    '-f',
    '-a',
    '-o=',
    '-O=',
    '--norc',
    '--noprofile',
    '--posix',
    '-r --restricted',
    '-p',
    '--version',
    '--help',
    o('--rcfile= --init-file=', { role: 'read', effects: ['exec:file'] }),
  ),
  finish(parsed) {
    const [first] = parsed.positionals;
    if (parsed.options['-c']) {
      if (first) parsed.scripts.push(first);
    } else if (parsed.maybeOptions) {
      // A word only known at run time may be -c, which makes the first positional after it code.
      parsed.scripts.push(...parsed.positionals);
      parsed.effects.add('exec:arbitrary');
    } else if (first && !parsed.options['-s']) {
      parsed.effects.add('exec:file');
      parsed.reads.push(first);
    } else if (!parsed.options['-n'] && !parsed.options['--version'] && !parsed.options['--help']) {
      parsed.effects.add('exec:arbitrary');
      parsed.stdinScript = true;
    }
  },
};

/**
 * A language interpreter: inline code is arbitrary code, a positional is a file it runs, nothing at all runs stdin.
 * Options that say what runs (`-c`, `-m`) carry their own effects.
 */
function interpreter(options: OptionSpec[]): CommandSpec {
  const quiet = ['--version', '-V', '--help', '-h'];
  return {
    posix: true,
    options: [...options, ...opts(...quiet)],
    finish(parsed) {
      if (Object.keys(parsed.options).some((name) => quiet.includes(name))) return;
      if (options.some((option) => (option.effects?.length ?? 0) > 0 && parsed.options[option.names[0]!] !== undefined)) return;
      const [first] = parsed.positionals;
      if (first) {
        parsed.effects.add('exec:file');
        parsed.reads.push(first);
      } else {
        parsed.effects.add('exec:arbitrary');
      }
    },
  };
}

const inline = (spellings: string) => o(spellings, { effects: ['exec:arbitrary'] });

/** Reads its positionals, with the options given (so their values aren't taken for paths). */
function reader(...options: (string | OptionSpec)[]): CommandSpec {
  return { abbreviations: true, positionals: 'read', effects: ['fs:read'], options: opts(...options) };
}

/** Writes or deletes its positionals. */
function writer(effect: Effect, ...options: (string | OptionSpec)[]): CommandSpec {
  return { abbreviations: true, positionals: effect === 'fs:delete' ? 'delete' : 'write', effects: [effect], options: opts(...options) };
}

function noCommandWithPid(parsed: Parsed): void {
  if (parsed.options['--pid']) parsed.nested = [];
}

/** `git push`: a refspec starting with `+` forces, one starting with `:` deletes. */
function finishPush(parsed: Parsed): void {
  for (const refspec of parsed.positionals.slice(1)) {
    const value = staticValue(refspec);
    if (value === undefined) parsed.maybeOptions = true;
    else if (value.startsWith('+')) (parsed.options['--force'] ??= []).push(refspec);
    else if (value.startsWith(':')) (parsed.options['--delete'] ??= []).push(refspec);
  }
}

/** Git config keys whose values git runs, or that change what or where it runs. */
const gitExecKeys =
  /^(alias\..*|core\.(pager|editor|sshcommand|fsmonitor|hookspath|askpass|gitproxy|worktree)|sequence\.editor|pager\..*|diff\.external|diff\..*\.(command|textconv)|merge\..*\.driver|filter\..*\.(clean|smudge|process)|credential\.helper|credential\..*\.helper|gpg\.program|gpg\..*\.program|interactive\.difffilter|uploadpack\.packobjectshook|remote\..*\.(uploadpack|receivepack|vcs)|protocol\..*\.allow|url\..*|include\.path|includeif\..*|submodule\..*\.update|ssh\.variant|core\.sshcommand|http\..*proxy|web\.browser|browser\..*\.(cmd|path)|man\..*\.(cmd|path)|sendemail\..*cmd|mergetool\..*\.cmd|difftool\..*\.cmd)$/;

/** Keys whose value is a command git runs with the shell. */
const gitShellKeys =
  /^(core\.(pager|editor|sshcommand|fsmonitor|askpass)|sequence\.editor|pager\..*|diff\.external|diff\..*\.(command|textconv)|merge\..*\.driver|filter\..*\.(clean|smudge|process)|gpg\.program|interactive\.difffilter|uploadpack\.packobjectshook|browser\..*\.cmd|man\..*\.cmd|mergetool\..*\.cmd|difftool\..*\.cmd)$/;

/**
 * What a git config entry means for running git: `undefined` when it's harmless, `{}` when it changes what git runs
 * without being code (`core.hooksPath`, `url.*`), and `{ script }` when its value is shell code (`alias.x=!…`, `core.pager`).
 */
export function gitConfig(key: string, value: string): { script?: string } | undefined {
  const name = key.toLowerCase();
  if (!gitExecKeys.test(name)) return undefined;
  if (name.startsWith('alias.')) return value.startsWith('!') ? { script: value.slice(1) } : undefined;
  if (name === 'core.fsmonitor' && /^(true|false)$/i.test(value)) return undefined;
  if (name.startsWith('pager.') && /^(true|false|yes|no|on|off|1|0)?$/i.test(value)) return undefined;
  if (name.startsWith('credential.') && value.startsWith('!')) return { script: value.slice(1) };
  return gitShellKeys.test(name) ? { script: value } : {};
}

/** `git config key value` (and `--add`, `--replace-all`) sets an entry: read like `-c key=value`. */
function finishConfig(parsed: Parsed): void {
  const reading = ['--get', '--get-all', '--get-regexp', '--list', '--unset', '--unset-all', '--remove-section', '--rename-section'];
  if (reading.some((name) => parsed.options[name])) return;
  const [key, value] = parsed.positionals;
  if (!key || !value) return;
  parsed.effects.add('fs:write');
  if (!parsed.options['--global'] && !parsed.options['--system'] && !parsed.options['--worktree']) {
    const file = parsed.options['--file']?.[0];
    parsed.writes.push(file !== undefined && file !== true ? file : { kind: 'static', value: '.git/config' });
  }
  const k = staticValue(key);
  const v = staticValue(value);
  parsed.configs.push(k !== undefined && v !== undefined ? { kind: 'static', value: `${k}=${v}` } : value);
}

const hooks: Effect[] = ['fs:write', 'exec:project'];

const git: CommandSpec = {
  options: opts(
    o('-C=', { role: 'cwd' }),
    o('-c=', { role: 'config' }),
    o('--config-env=', { role: 'config' }),
    o('--exec-path=?', { effects: ['exec:file'] }),
    '--git-dir=',
    '--work-tree=',
    '--namespace=',
    '-p --paginate',
    '-P --no-pager',
    '--bare',
    '--no-replace-objects',
    '--literal-pathspecs',
    '--no-optional-locks',
    '--list-cmds=',
    '--version',
    '--help',
  ),
  subcommands: {
    status: {
      abbreviations: true,
      options: opts('-s --short', '-b --branch', '--porcelain=?', '-u --untracked-files=?', '--ignored=?', '-z'),
    },
    log: {
      abbreviations: true,
      options: opts(
        '-n= --max-count=',
        '--format=?',
        '--pretty=?',
        '--author=',
        '--grep=',
        '--since=',
        '--until=',
        '--oneline',
        o('--output=', { role: 'write' }),
      ),
    },
    show: { abbreviations: true, options: opts('--format=?', '--pretty=?', '--stat=?', '--name-only', o('--output=', { role: 'write' })) },
    diff: {
      abbreviations: true,
      options: opts(
        '--cached --staged',
        '--stat=?',
        '--name-only',
        '--name-status',
        '--no-ext-diff',
        o('--ext-diff', { effects: ['exec:project'] }),
        o('--output=', { role: 'write' }),
      ),
    },
    ...each(
      'blame annotate shortlog reflog describe rev-parse rev-list ls-files ls-tree show-ref cat-file whatchanged merge-base name-rev count-objects var check-ignore check-attr for-each-ref help version',
      { abbreviations: true },
    ),
    'ls-remote': { abbreviations: true, effects: ['network'] },
    grep: { abbreviations: true, options: opts('-e=', '-f=', o('-O --open-files-in-pager=?', { effects: ['exec:arbitrary'] })) },
    'add|stage': {
      abbreviations: true,
      effects: ['fs:write'],
      options: opts('-A --all', '-u --update', '-f --force', '-p --patch', '-n --dry-run', '-N --intent-to-add', '-v --verbose'),
    },
    commit: {
      abbreviations: true,
      effects: hooks,
      options: opts(
        '-m= --message=',
        o('-F= --file=', { role: 'read' }),
        '-a --all',
        '--amend',
        '-n --no-verify',
        '--fixup=',
        '--squash=',
        '-C= --reuse-message=',
        '-c= --reedit-message=',
        '-e --edit',
        '--no-edit',
        '-S --gpg-sign=?',
        '--author=',
        '--date=',
        '-q --quiet',
        '-v --verbose',
        '--allow-empty',
        '-s --signoff',
        o('-t= --template=', { role: 'read' }),
      ),
    },
    push: {
      abbreviations: true,
      effects: ['network', 'exec:project'],
      options: opts(
        '-f --force',
        '--force-with-lease=?',
        '--force-if-includes',
        '-d --delete',
        '--mirror',
        '--all --branches',
        '--tags',
        '--follow-tags',
        '-u --set-upstream',
        '-n --dry-run',
        '--no-verify',
        '--verify',
        '-o= --push-option=',
        o('--receive-pack= --exec=', { effects: ['exec:arbitrary'] }),
        '--repo=',
        '--prune',
        '--atomic',
        '-q --quiet',
        '-v --verbose',
        '--porcelain',
        '--signed=?',
        '--recurse-submodules=',
      ),
      finish: finishPush,
    },
    pull: {
      abbreviations: true,
      effects: ['network', ...hooks],
      options: opts(
        '-r --rebase=?',
        '--no-rebase',
        '--ff-only',
        '--no-ff',
        '-f --force',
        '--no-verify',
        '-s= --strategy=',
        '-X= --strategy-option=',
        o('--upload-pack=', { effects: ['exec:arbitrary'] }),
      ),
    },
    fetch: {
      abbreviations: true,
      effects: ['network', 'fs:write'],
      options: opts('--all', '-p --prune', '-f --force', '-t --tags', '--depth=', o('--upload-pack=', { effects: ['exec:arbitrary'] })),
    },
    clone: {
      abbreviations: true,
      effects: ['network', 'fs:write'],
      options: opts(
        '-b= --branch=',
        '--depth=',
        '--bare',
        '--mirror',
        '-n --no-checkout',
        '--single-branch',
        '--filter=',
        '-o= --origin=',
        '--recurse-submodules=?',
        o('-c= --config=', { role: 'config' }),
        o('-u= --upload-pack=', { effects: ['exec:arbitrary'] }),
        o('--template=', { effects: ['exec:project'] }),
      ),
    },
    checkout: {
      abbreviations: true,
      effects: hooks,
      options: opts(
        '-b=',
        '-B=',
        '-f --force',
        '--orphan=',
        '-t --track=?',
        '--detach',
        '-p --patch',
        '--ours',
        '--theirs',
        '-m --merge',
        '-q --quiet',
      ),
    },
    switch: {
      abbreviations: true,
      effects: hooks,
      options: opts('-c= --create=', '-C= --force-create=', '-f --force --discard-changes', '-d --detach', '--orphan=', '-t --track=?'),
    },
    restore: { abbreviations: true, effects: ['fs:write'], options: opts('-s= --source=', '-S --staged', '-W --worktree', '-p --patch') },
    reset: {
      abbreviations: true,
      effects: ['fs:write'],
      options: opts('--hard', '--soft', '--mixed', '--keep', '--merge', '-p --patch', '-q --quiet'),
    },
    clean: {
      abbreviations: true,
      effects: ['fs:delete'],
      options: opts('-f --force', '-d', '-x', '-X', '-n --dry-run', '-i --interactive', '-e= --exclude=', '-q --quiet'),
    },
    branch: {
      abbreviations: true,
      options: opts(
        '-d --delete',
        '-D',
        '-f --force',
        '-m --move',
        '-M',
        '-c --copy',
        '-C',
        '-a --all',
        '-r --remotes',
        '-l --list',
        '-v --verbose',
        '--show-current',
        '-u= --set-upstream-to=',
        '--unset-upstream',
        '--contains=?',
        '--merged=?',
        '--no-merged=?',
        '--sort=',
        '--format=',
      ),
      finish(parsed) {
        if (!parsed.options['-D']) return;
        (parsed.options['--delete'] ??= []).push(true);
        (parsed.options['--force'] ??= []).push(true);
      },
    },
    tag: {
      abbreviations: true,
      options: opts(
        '-d --delete',
        '-f --force',
        '-a --annotate',
        '-m= --message=',
        o('-F= --file=', { role: 'read' }),
        '-s --sign',
        '-l --list',
      ),
    },
    merge: {
      abbreviations: true,
      effects: hooks,
      options: opts(
        '--no-ff',
        '--ff-only',
        '--squash',
        '--abort',
        '--continue',
        '-m=',
        '-s= --strategy=',
        '-X= --strategy-option=',
        '--no-verify',
        '--allow-unrelated-histories',
      ),
    },
    rebase: {
      abbreviations: true,
      effects: hooks,
      options: opts(
        '-i --interactive',
        o('-x= --exec=', { role: 'script' }),
        '--onto=',
        '--abort',
        '--continue',
        '--skip',
        '--autosquash',
        '--root',
        '-s= --strategy=',
        '-X= --strategy-option=',
        '--no-verify',
        '--update-refs',
      ),
    },
    ...each('cherry-pick revert', {
      abbreviations: true,
      effects: hooks,
      options: opts('-n --no-commit', '-e --edit', '-m= --mainline=', '--continue', '--abort', '-x'),
    }),
    stash: {
      abbreviations: true,
      effects: ['fs:write'],
      subcommands: {
        ...each('push save', {
          abbreviations: true,
          effects: ['fs:write'],
          options: opts('-m= --message=', '-u --include-untracked', '-a --all', '-k --keep-index', '-p --patch'),
        }),
        ...each('pop apply branch', { effects: ['fs:write'] }),
        ...each('drop clear', { effects: ['fs:delete'] }),
        ...each('list show', {}),
      },
    },
    remote: {
      options: opts('-v --verbose'),
      subcommands: {
        ...each('add remove|rm rename set-url set-head set-branches', { effects: ['fs:write'] }),
        'get-url': {},
        ...each('show prune update', { effects: ['network'] }),
      },
    },
    config: {
      abbreviations: true,
      options: opts(
        '--global',
        '--system',
        '--local',
        '--worktree',
        o('-f= --file=', { role: 'write' }),
        '--get',
        '--get-all',
        '--get-regexp',
        '-l --list',
        '--add',
        '--replace-all',
        '--unset',
        '--unset-all',
        '--remove-section',
        '--rename-section',
        '--type=',
        '--bool',
        '--int',
      ),
      finish: finishConfig,
    },
    rm: {
      abbreviations: true,
      effects: ['fs:delete'],
      positionals: 'delete',
      options: opts('-r', '-f --force', '--cached', '-n --dry-run', '-q --quiet'),
    },
    mv: { abbreviations: true, effects: ['fs:write'], options: opts('-f --force', '-k', '-n --dry-run', '-v --verbose') },
    ...each('apply am', { abbreviations: true, effects: hooks }),
    submodule: { effects: ['network', ...hooks] },
    worktree: { effects: ['fs:write'] },
    init: {
      abbreviations: true,
      effects: ['fs:write'],
      options: opts('--bare', '-b= --initial-branch=', o('--template=', { effects: ['exec:project'] })),
    },
    bisect: {
      effects: ['fs:write'],
      subcommands: {
        run: { command: {} },
        ...each('start bad good new old skip reset log replay visualize|view terms', { effects: ['fs:write'] }),
      },
    },
    ...each('difftool mergetool', {
      abbreviations: true,
      effects: ['exec:project'],
      options: opts(o('-x= --extcmd=', { role: 'script' }), '-t= --tool=', '-y --no-prompt', '-g --gui'),
    }),
    'filter-branch': {
      effects: ['fs:write'],
      options: [
        ...[
          '--env-filter=',
          '--tree-filter=',
          '--index-filter=',
          '--parent-filter=',
          '--msg-filter=',
          '--commit-filter=',
          '--tag-name-filter=',
        ].map((name) => o(name, { role: 'script' })),
        ...opts('--subdirectory-filter=', '-f --force'),
      ],
    },
    archive: {
      abbreviations: true,
      options: opts(
        o('-o= --output=', { role: 'write' }),
        o('--remote=', { effects: ['network'] }),
        o('--exec=', { effects: ['exec:arbitrary'] }),
        '--format=',
        '--prefix=',
      ),
    },
    'format-patch': { abbreviations: true, effects: ['fs:write'], options: opts(o('-o= --output-directory=', { role: 'write' })) },
    ...each('gc prune repack fsck maintenance notes update-ref update-index symbolic-ref replace sparse-checkout lfs', {
      effects: ['fs:write'],
    }),
  },
};

const sshOptions = opts(
  ...'-b= -c= -D= -E= -e= -F= -I= -i= -J= -L= -l= -m= -O= -o= -p= -Q= -R= -S= -W= -w= -B='.split(' '),
  ...'-4 -6 -A -a -C -f -G -g -K -k -M -N -n -q -s -T -t -V -v -X -x -Y -y'.split(' '),
);

/** What ssh's options run (`-o ProxyCommand`), the config it reads (`-F`), and `command`, run on the remote host. */
function sshRuns(options: Parsed['options'], command: Arg[], parsed: Parsed): void {
  parsed.reads.push(...(options['-F'] ?? []).filter((value): value is Arg => value !== true));
  for (const value of options['-o'] ?? []) {
    if (value === true) continue;
    if (value.kind === 'dynamic') {
      parsed.maybeOptions = true;
      continue;
    }
    const match = /^(?:ProxyCommand|LocalCommand|KnownHostsCommand)(?:\s+|=\s*)(.+)$/i.exec(value.value);
    if (match) parsed.effects.add('exec:arbitrary');
  }
  if (command.length === 0) return;
  parsed.effects.add('exec:remote');
  const dynamic = command.find((arg) => arg.kind === 'dynamic');
  parsed.scripts.push(dynamic ?? { kind: 'static', value: command.map((arg) => staticValue(arg)).join(' ') });
}

/** A word gh doesn't know is an alias (a shell one, with `!`) or an extension: code of its own. */
function finishGh(parsed: Parsed): void {
  if (parsed.subcommands.length === 0 && parsed.unknownSubcommand) parsed.effects.add('exec:arbitrary');
}

/** `gh alias set name expansion` defines code that runs later: shell code (`--shell`, or `!`), else a gh command line. */
function finishAlias(parsed: Parsed): void {
  const expansion = parsed.positionals[1];
  const value = staticValue(expansion);
  if (!expansion || value === '-') parsed.effects.add('exec:arbitrary');
  else if (value === undefined) parsed.scripts.push(expansion);
  else if (parsed.options['--shell'] || value.startsWith('!')) parsed.scripts.push({ kind: 'static', value: value.replace(/^!/, '') });
  else parsed.argvStrings.push({ kind: 'static', value: `gh ${value}` });
}

/** `gh config set editor|pager|browser value`: a command line gh runs later, split as shell words. */
function finishGhConfig(parsed: Parsed): void {
  const [key, value] = parsed.positionals;
  const name = staticValue(key);
  if (value && (name === undefined || /^(editor|pager|browser)$/.test(name))) parsed.argvStrings.push(value);
}

/** `-F key=@file` takes the value from a file (`@-`: standard input). */
function finishFields(parsed: Parsed): void {
  for (const field of parsed.options['--field'] ?? []) {
    if (field === true) continue;
    if (field.kind === 'dynamic') {
      if (/^[^=]*(=(@.*)?)?$/.test(field.prefix)) parsed.reads.push(field);
      continue;
    }
    const file = /^[^=]*=@(.+)$/.exec(field.value)?.[1];
    if (file && file !== '-') parsed.reads.push({ kind: 'static', value: file });
  }
}

/** `gh repo clone` and `gh gist clone` run `git clone` with the arguments after the repository, `--` ones included. */
function finishClone(parsed: Parsed): void {
  const [repository, ...rest] = parsed.positionals;
  if (repository)
    parsed.nested.push({ argv: [{ kind: 'static', value: 'git' }, { kind: 'static', value: 'clone' }, ...rest, repository], open: false });
}

/** `gh repo fork --clone [repository] [-- gitflags]`: the flags go to `git clone`. */
function finishFork(parsed: Parsed): void {
  if (!parsed.options['--clone']) return;
  parsed.effects.add('fs:write');
  parsed.nested.push({ argv: [{ kind: 'static', value: 'git' }, { kind: 'static', value: 'clone' }, ...parsed.positionals], open: false });
}

/** `gh release create|upload tag files…` uploads the files. */
function finishAssets(parsed: Parsed): void {
  parsed.reads.push(...parsed.positionals.slice(1));
}

function finishVerifyAsset(parsed: Parsed): void {
  const file = parsed.positionals.at(-1);
  if (file) parsed.reads.push(file);
}

/**
 * `gh codespace ssh` and `cp` split their arguments as gh does: flags (those in `valued` take the next word), then the
 * rest. The flags go to ssh or scp, whose config file (`-F`) isn't followed as ssh's is.
 */
function codespaceArgs(parsed: Parsed, valued: string): { options: Parsed['options']; rest: Arg[] } {
  const args = parsed.positionals;
  let i = 0;
  for (let value = staticValue(args[0]); value?.startsWith('-'); value = staticValue(args[i]))
    i += value.length === 2 && valued.includes(value[1]!) ? 2 : 1;
  const { options } = normalize(args.slice(0, i), { options: opts(...valued.split('').map((letter) => `-${letter}=`)) });
  const rest = args.slice(i);
  const next = rest[0];
  if (options['-F'] || (next?.kind === 'dynamic' && (next.prefix === '' || next.prefix.startsWith('-')))) {
    parsed.maybeOptions = true;
    parsed.effects.add('exec:arbitrary');
  }
  return { options, rest };
}

/** `gh codespace ssh [flags] [command]`: the command runs in the codespace. */
function finishCodespaceSsh(parsed: Parsed): void {
  const { options, rest } = codespaceArgs(parsed, 'bcDeFIiLlmOopRSWw');
  sshRuns(options, rest, parsed);
}

/** `gh codespace cp [flags] sources… destination`: paths starting `remote:` are in the codespace. scp's `-S` is a program. */
function finishCodespaceCopy(parsed: Parsed): void {
  const { options, rest } = codespaceArgs(parsed, 'cFiJloPS');
  sshRuns(options, [], parsed);
  if (options['-S']) parsed.effects.add('exec:arbitrary');
  const local = (arg: Arg) => !staticValue(arg)?.startsWith('remote:');
  parsed.reads.push(...rest.slice(0, -1).filter(local));
  const destination = rest.at(-1);
  if (!destination || !local(destination)) return;
  parsed.effects.add('fs:write');
  parsed.writes.push(destination);
}

/** Each level's options apply under it too, as cobra's persistent flags do (`gh pr -R` is `gh pr merge -R`). */
function persistent(spec: CommandSpec, inherited: OptionSpec[] = []): CommandSpec {
  const options = [...(spec.options ?? []), ...inherited];
  if (!spec.subcommands) return { ...spec, options };
  const subcommands = Object.fromEntries(Object.entries(spec.subcommands).map(([name, sub]) => [name, persistent(sub, options)]));
  return { ...spec, options, subcommands };
}

const json = opts('-q= --jq=', '--json=', '-t= --template=');
const codespace = opts('-c= --codespace=', '-R= --repo=', '--repo-owner=');

/** The GitHub CLI. Nearly every command calls the API; those that run git (`pr checkout`) run its hooks. */
const gh: CommandSpec = {
  ...persistent({
    options: opts('--help', '--version'),
    subcommands: {
      'agent-task|agent-tasks|agent|agents': {
        effects: ['network'],
        subcommands: {
          create: { options: opts('-b= --base=', '-a= --custom-agent=', '--follow', o('-F= --from-file=', { role: 'read' })) },
          list: { options: opts('-L= --limit=', '-w --web', ...json) },
          view: { options: opts('--follow', '--log', '-w --web', ...json) },
        },
      },
      alias: {
        subcommands: {
          delete: { effects: ['fs:write'], options: opts('--all') },
          import: { effects: ['fs:write'], positionals: 'read', options: opts('--clobber') },
          'list|ls': {},
          set: { effects: ['fs:write'], options: opts('--clobber', '-s --shell'), finish: finishAlias },
        },
      },
      api: {
        effects: ['network'],
        options: opts(
          '--cache=',
          '-F= --field=',
          '-H= --header=',
          '--hostname=',
          '-i --include',
          o('--input=', { role: 'read' }),
          '-q= --jq=',
          '-X= --method=',
          '--paginate',
          '-p= --preview=',
          '-f= --raw-field=',
          '--silent',
          '--slurp',
          '-t= --template=',
          '--verbose',
        ),
        finish: finishFields,
      },
      'attestation|at': {
        effects: ['network'],
        subcommands: {
          download: {
            effects: ['fs:write'],
            options: opts('-d= --digest-alg=', '--hostname=', '-L= --limit=', '-o= --owner=', '--predicate-type=', '-R= --repo='),
          },
          'trusted-root': { options: opts('--hostname=', o('--tuf-root=', { role: 'read' }), '--tuf-url=', '--verify-only') },
          verify: {
            positionals: 'read',
            options: opts(
              o('-b= --bundle=', { role: 'read' }),
              '--bundle-from-oci',
              '--cert-identity=',
              '-i= --cert-identity-regex=',
              '--cert-oidc-issuer=',
              o('--custom-trusted-root=', { role: 'read' }),
              '--deny-self-hosted-runners',
              '-d= --digest-alg=',
              '--format=',
              '--hostname=',
              '-q= --jq=',
              '-L= --limit=',
              '--no-public-good',
              '-o= --owner=',
              '--predicate-type=',
              '-R= --repo=',
              '--signer-digest=',
              '--signer-repo=',
              '--signer-workflow=',
              '--source-digest=',
              '--source-ref=',
              '-t= --template=',
            ),
          },
        },
      },
      auth: {
        subcommands: {
          login: {
            effects: ['network', 'fs:write'],
            options: opts(
              '-c --clipboard',
              '-p= --git-protocol=',
              '-h= --hostname=',
              '--insecure-storage',
              '-s= --scopes=',
              '--skip-ssh-key',
              '-w --web',
              '--with-token',
            ),
          },
          logout: { effects: ['network', 'fs:write'], options: opts('-h= --hostname=', '-u= --user=') },
          refresh: {
            effects: ['network', 'fs:write'],
            options: opts(
              '-c --clipboard',
              '-h= --hostname=',
              '--insecure-storage',
              '-r= --remove-scopes=',
              '--reset-scopes',
              '-s= --scopes=',
            ),
          },
          'setup-git': { effects: ['fs:write'], options: opts('-f --force', '-h= --hostname=') },
          status: {
            effects: ['network'],
            options: opts('-a --active', '-h= --hostname=', '--jq=', '--json=', '-t --show-token', '--template='),
          },
          switch: { effects: ['fs:write'], options: opts('-h= --hostname=', '-u= --user=') },
          token: { options: opts('-h= --hostname=', '-u= --user=') },
        },
      },
      browse: {
        effects: ['network'],
        options: opts(
          '-R= --repo=',
          '-a --actions',
          '--blame',
          '-b= --branch=',
          '-c=? --commit=?',
          '-n --no-browser',
          '-p --projects',
          '-r --releases',
          '-s --settings',
          '-w --wiki',
        ),
      },
      cache: {
        effects: ['network'],
        options: opts('-R= --repo='),
        subcommands: {
          delete: { options: opts('-a --all', '-r= --ref=', '--succeed-on-no-caches') },
          'list|ls': { options: opts('-k= --key=', '-L= --limit=', '-O= --order=', '-r= --ref=', '-S= --sort=', ...json) },
        },
      },
      'codespace|cs': {
        effects: ['network'],
        subcommands: {
          code: { options: opts('--insiders', '-w --web', ...codespace) },
          cp: {
            options: opts(o('-e --expand', { effects: ['exec:remote'] }), '-p= --profile=', '-r --recursive', ...codespace),
            finish: finishCodespaceCopy,
          },
          create: {
            options: opts(
              '-b= --branch=',
              '--default-permissions',
              '--devcontainer-path=',
              '-d= --display-name=',
              '--idle-timeout=',
              '-l= --location=',
              '-m= --machine=',
              '-R= --repo=',
              '--retention-period=',
              '-s --status',
              '-w --web',
            ),
          },
          delete: { options: opts('--all', '--days=', '-f --force', '-o= --org=', '-u= --user=', ...codespace) },
          edit: { options: opts('-d= --display-name=', '-m= --machine=', ...codespace) },
          jupyter: { options: opts(...codespace) },
          'list|ls': { options: opts('-L= --limit=', '-o= --org=', '-R= --repo=', '-u= --user=', '-w --web', ...json) },
          logs: { options: opts('-f --follow', ...codespace) },
          ports: {
            options: opts(...json, ...codespace),
            subcommands: {
              forward: {},
              visibility: {},
            },
          },
          rebuild: { options: opts('--full', ...codespace) },
          ssh: {
            options: opts(
              '--config',
              o('-d --debug', { effects: ['fs:write'] }),
              o('--debug-file=', { role: 'write' }),
              '--profile=',
              '--server-port=',
              ...codespace,
            ),
            finish: finishCodespaceSsh,
          },
          stop: { options: opts('-o= --org=', '-u= --user=', ...codespace) },
          view: { options: opts(...json, ...codespace) },
        },
      },
      completion: { options: opts('-s= --shell=') },
      config: {
        subcommands: {
          'clear-cache': { effects: ['fs:delete'] },
          get: { options: opts('-h= --host=') },
          'list|ls': { options: opts('-h= --host=') },
          set: { effects: ['fs:write'], options: opts('-h= --host='), finish: finishGhConfig },
        },
      },
      copilot: { effects: ['exec:arbitrary', 'fs:write'], options: opts('--remove') },
      discussion: {
        effects: ['network'],
        options: opts('-R= --repo='),
        subcommands: {
          comment: { options: opts('-b= --body=', o('-F= --body-file=', { role: 'read' }), '--delete', '--edit', '--yes') },
          create: {
            options: opts('-b= --body=', o('-F= --body-file=', { role: 'read' }), '-c= --category=', '-l= --label=', '-t= --title='),
          },
          edit: {
            options: opts(
              '--add-label=',
              '-b= --body=',
              o('-F= --body-file=', { role: 'read' }),
              '-c= --category=',
              '--remove-label=',
              '-t= --title=',
            ),
          },
          'list|ls': {
            options: opts(
              '--after=',
              '--answered',
              '-A= --author=',
              '-c= --category=',
              '-l= --label=',
              '-L= --limit=',
              '--order=',
              '-S= --search=',
              '--sort=',
              '-s= --state=',
              '-w --web',
              ...json,
            ),
          },
          view: { options: opts('--after=', '-c --comments', '-L= --limit=', '--order=', '-w --web', ...json) },
        },
      },
      'extension|extensions|ext': {
        subcommands: {
          browse: { effects: ['network', 'fs:write'], options: opts(o('--debug', { effects: ['fs:write'] }), '-s --single-column') },
          create: { effects: ['fs:write'], options: opts('--precompiled=') },
          exec: { effects: ['exec:arbitrary'] },
          install: { effects: ['network', 'fs:write'], options: opts('--force', '--pin=') },
          'list|ls': {},
          'remove|uninstall': { effects: ['fs:delete'] },
          search: {
            effects: ['network'],
            options: opts('--license=', '-L= --limit=', '--order=', '--owner=', '--sort=', '-w --web', ...json),
          },
          upgrade: { effects: ['network', 'fs:write'], options: opts('--all', '--dry-run', '--force') },
        },
      },
      gist: {
        effects: ['network'],
        subcommands: {
          clone: { finish: finishClone },
          'create|new': { positionals: 'read', options: opts('-d= --desc=', '-f= --filename=', '-p --public', '-w --web') },
          delete: { options: opts('--yes') },
          edit: { options: opts(o('-a= --add=', { role: 'read' }), '-d= --desc=', '-f= --filename=', '-r= --remove=') },
          'list|ls': { options: opts('--filter=', '--include-content', '-L= --limit=', '--public', '--secret') },
          rename: {},
          view: { options: opts('-f= --filename=', '--files', '-r --raw', '-w --web') },
        },
      },
      'gpg-key': {
        effects: ['network'],
        subcommands: {
          add: { positionals: 'read', options: opts('-t= --title=') },
          delete: { options: opts('-y --yes') },
          'list|ls': {},
        },
      },
      issue: {
        effects: ['network'],
        options: opts('-R= --repo='),
        subcommands: {
          close: { options: opts('-c= --comment=', '--duplicate-of=', '-r= --reason=') },
          comment: {
            options: opts(
              '-b= --body=',
              o('-F= --body-file=', { role: 'read' }),
              '--create-if-none',
              '--delete-last',
              '--edit-last',
              '-e --editor',
              '-w --web',
              '--yes',
            ),
          },
          'create|new': {
            options: opts(
              '-a= --assignee=',
              '--blocked-by=',
              '--blocking=',
              '-b= --body=',
              o('-F= --body-file=', { role: 'read' }),
              '-e --editor',
              '-l= --label=',
              '-m= --milestone=',
              '--parent=',
              '-p= --project=',
              o('--recover=', { role: 'read' }),
              '-T= --template=',
              '-t= --title=',
              '--type=',
              '-w --web',
            ),
          },
          delete: { options: opts('--yes') },
          develop: { options: opts('-b= --base=', '--branch-repo=', o('-c --checkout', { effects: hooks }), '-l --list', '-n= --name=') },
          edit: {
            options: opts(
              '--add-assignee=',
              '--add-blocked-by=',
              '--add-blocking=',
              '--add-label=',
              '--add-project=',
              '--add-sub-issue=',
              '-b= --body=',
              o('-F= --body-file=', { role: 'read' }),
              '-m= --milestone=',
              '--parent=',
              '--remove-assignee=',
              '--remove-blocked-by=',
              '--remove-blocking=',
              '--remove-label=',
              '--remove-milestone',
              '--remove-parent',
              '--remove-project=',
              '--remove-sub-issue=',
              '--remove-type',
              '-t= --title=',
              '--type=',
            ),
          },
          'list|ls': {
            options: opts(
              '--app=',
              '-a= --assignee=',
              '-A= --author=',
              '-l= --label=',
              '-L= --limit=',
              '--mention=',
              '-m= --milestone=',
              '-S= --search=',
              '-s= --state=',
              '--type=',
              '-w --web',
              ...json,
            ),
          },
          lock: { options: opts('-r= --reason=') },
          pin: {},
          reopen: { options: opts('-c= --comment=') },
          status: { options: opts(...json) },
          transfer: {},
          unlock: {},
          unpin: {},
          view: { options: opts('-c --comments', '-w --web', ...json) },
        },
      },
      label: {
        effects: ['network'],
        options: opts('-R= --repo='),
        subcommands: {
          clone: { options: opts('-f --force') },
          create: { options: opts('-c= --color=', '-d= --description=', '-f --force') },
          delete: { options: opts('--yes') },
          edit: { options: opts('-c= --color=', '-d= --description=', '-n= --name=') },
          'list|ls': { options: opts('-L= --limit=', '--order=', '-S= --search=', '--sort=', '-w --web', ...json) },
        },
      },
      help: {},
      licenses: {},
      org: {
        effects: ['network'],
        subcommands: {
          'list|ls': { options: opts('-L= --limit=') },
        },
      },
      pr: {
        effects: ['network'],
        options: opts('-R= --repo='),
        subcommands: {
          'checkout|co': { effects: hooks, options: opts('-b= --branch=', '--detach', '-f --force', '--recurse-submodules') },
          checks: { options: opts('--fail-fast', '-i= --interval=', '--required', '--watch', '-w --web', ...json) },
          close: { options: opts('-c= --comment=', o('-d --delete-branch', { effects: hooks })) },
          comment: {
            options: opts(
              '-b= --body=',
              o('-F= --body-file=', { role: 'read' }),
              '--create-if-none',
              '--delete-last',
              '--edit-last',
              '-e --editor',
              '-w --web',
              '--yes',
            ),
          },
          'create|new': {
            effects: ['exec:project'],
            options: opts(
              '-a= --assignee=',
              '-B= --base=',
              '-b= --body=',
              o('-F= --body-file=', { role: 'read' }),
              '-d --draft',
              '--dry-run',
              '-e --editor',
              '-f --fill',
              '--fill-first',
              '--fill-verbose',
              '-H= --head=',
              '-l= --label=',
              '-m= --milestone=',
              '--no-maintainer-edit',
              '-p= --project=',
              o('--recover=', { role: 'read' }),
              '-r= --reviewer=',
              '-T= --template=',
              '-t= --title=',
              '-w --web',
            ),
          },
          diff: { options: opts('--color=', '-e= --exclude=', '--name-only', '--patch', '-w --web') },
          edit: {
            options: opts(
              '--add-assignee=',
              '--add-label=',
              '--add-project=',
              '--add-reviewer=',
              '-B= --base=',
              '-b= --body=',
              o('-F= --body-file=', { role: 'read' }),
              '-m= --milestone=',
              '--remove-assignee=',
              '--remove-label=',
              '--remove-milestone',
              '--remove-project=',
              '--remove-reviewer=',
              '-t= --title=',
            ),
          },
          'list|ls': {
            options: opts(
              '--app=',
              '-a= --assignee=',
              '-A= --author=',
              '-B= --base=',
              '-d --draft',
              '-H= --head=',
              '-l= --label=',
              '-L= --limit=',
              '-S= --search=',
              '-s= --state=',
              '-w --web',
              ...json,
            ),
          },
          lock: { options: opts('-r= --reason=') },
          merge: {
            options: opts(
              '--admin',
              '-A= --author-email=',
              '--auto',
              '-b= --body=',
              o('-F= --body-file=', { role: 'read' }),
              o('-d --delete-branch', { effects: hooks }),
              '--disable-auto',
              '--match-head-commit=',
              '-m --merge',
              '-r --rebase',
              '-s --squash',
              '-t= --subject=',
            ),
          },
          ready: { options: opts('--undo') },
          reopen: { options: opts('-c= --comment=') },
          revert: { options: opts('-b= --body=', o('-F= --body-file=', { role: 'read' }), '-d --draft', '-t= --title=') },
          review: {
            options: opts('-a --approve', '-b= --body=', o('-F= --body-file=', { role: 'read' }), '-c --comment', '-r --request-changes'),
          },
          status: { options: opts('-c --conflict-status', ...json) },
          unlock: {},
          'update-branch': { options: opts('--rebase') },
          view: { options: opts('-c --comments', '-w --web', ...json) },
        },
      },
      preview: {
        subcommands: {
          prompter: {},
        },
      },
      project: {
        effects: ['network'],
        subcommands: {
          close: { options: opts('--format=', '-q= --jq=', '--owner=', '-t= --template=', '--undo') },
          copy: {
            options: opts('--drafts', '--format=', '-q= --jq=', '--source-owner=', '--target-owner=', '-t= --template=', '--title='),
          },
          create: { options: opts('--format=', '-q= --jq=', '--owner=', '-t= --template=', '--title=') },
          delete: { options: opts('--format=', '-q= --jq=', '--owner=', '-t= --template=') },
          edit: {
            options: opts(
              '-d= --description=',
              '--format=',
              '-q= --jq=',
              '--owner=',
              '--readme=',
              '-t= --template=',
              '--title=',
              '--visibility=',
            ),
          },
          'field-create': {
            options: opts('--data-type=', '--format=', '-q= --jq=', '--name=', '--owner=', '--single-select-options=', '-t= --template='),
          },
          'field-delete': { options: opts('--format=', '--id=', '-q= --jq=', '-t= --template=') },
          'field-list': { options: opts('--format=', '-q= --jq=', '-L= --limit=', '--owner=', '-t= --template=') },
          'item-add': { options: opts('--format=', '-q= --jq=', '--owner=', '-t= --template=', '--url=') },
          'item-archive': { options: opts('--format=', '--id=', '-q= --jq=', '--owner=', '-t= --template=', '--undo') },
          'item-create': { options: opts('--body=', '--format=', '-q= --jq=', '--owner=', '-t= --template=', '--title=') },
          'item-delete': { options: opts('--format=', '--id=', '-q= --jq=', '--owner=', '-t= --template=') },
          'item-edit': {
            options: opts(
              '--body=',
              '--clear',
              '--date=',
              '--field-id=',
              '--format=',
              '--id=',
              '--iteration-id=',
              '-q= --jq=',
              '--number=',
              '--project-id=',
              '--single-select-option-id=',
              '-t= --template=',
              '--text=',
              '--title=',
            ),
          },
          'item-list': { options: opts('--format=', '-q= --jq=', '-L= --limit=', '--owner=', '--query=', '-t= --template=') },
          link: { options: opts('--owner=', '-R= --repo=', '-T= --team=') },
          'list|ls': { options: opts('--closed', '--format=', '-q= --jq=', '-L= --limit=', '--owner=', '-t= --template=', '-w --web') },
          'mark-template': { options: opts('--format=', '-q= --jq=', '--owner=', '-t= --template=', '--undo') },
          unlink: { options: opts('--owner=', '-R= --repo=', '-T= --team=') },
          view: { options: opts('--format=', '-q= --jq=', '--owner=', '-t= --template=', '-w --web') },
        },
      },
      release: {
        effects: ['network'],
        options: opts('-R= --repo='),
        subcommands: {
          'create|new': {
            options: opts(
              '--discussion-category=',
              '-d --draft',
              '--fail-on-no-commits',
              '--generate-notes',
              '--latest',
              '-n= --notes=',
              o('-F= --notes-file=', { role: 'read' }),
              '--notes-from-tag',
              '--notes-start-tag=',
              '-p --prerelease',
              '--target=',
              '-t= --title=',
              '--verify-tag',
            ),
            finish: finishAssets,
          },
          delete: { options: opts('--cleanup-tag', '-y --yes') },
          'delete-asset': { options: opts('-y --yes') },
          download: {
            effects: ['fs:write'],
            options: opts(
              '-A= --archive=',
              '--clobber',
              o('-D= --dir=', { role: 'write' }),
              o('-O= --output=', { role: 'write' }),
              '-p= --pattern=',
              '--skip-existing',
            ),
          },
          edit: {
            options: opts(
              '--discussion-category=',
              '--draft',
              '--latest',
              '-n= --notes=',
              o('-F= --notes-file=', { role: 'read' }),
              '--prerelease',
              '--tag=',
              '--target=',
              '-t= --title=',
              '--verify-tag',
            ),
          },
          'list|ls': { options: opts('--exclude-drafts', '--exclude-pre-releases', '-L= --limit=', '-O= --order=', ...json) },
          upload: { options: opts('--clobber'), finish: finishAssets },
          verify: { options: opts('--format=', '-q= --jq=', '-t= --template=') },
          'verify-asset': { options: opts('--format=', '-q= --jq=', '-t= --template='), finish: finishVerifyAsset },
          view: { options: opts('-w --web', ...json) },
        },
      },
      repo: {
        effects: ['network'],
        subcommands: {
          archive: { options: opts('-y --yes') },
          autolink: {
            subcommands: {
              'create|new': { options: opts('-n --numeric') },
              delete: { options: opts('--yes') },
              'list|ls': { options: opts('-w --web', ...json) },
              view: { options: opts(...json) },
            },
          },
          clone: { options: opts('--no-upstream', '-u= --upstream-remote-name='), finish: finishClone },
          'create|new': {
            options: opts(
              '--add-readme',
              o('-c --clone', { effects: ['fs:write'] }),
              '-d= --description=',
              '--disable-issues',
              '--disable-wiki',
              '-g= --gitignore=',
              '-h= --homepage=',
              '--include-all-branches',
              '--internal',
              '-l= --license=',
              '--private',
              '--public',
              o('--push', { effects: ['exec:project'] }),
              '-r= --remote=',
              o('-s= --source=', { role: 'read', effects: ['fs:write'] }),
              '-t= --team=',
              '-p= --template=',
            ),
          },
          delete: { options: opts('--yes') },
          'deploy-key': {
            subcommands: {
              add: { positionals: 'read', options: opts('-w --allow-write', '-t= --title=') },
              delete: {},
              'list|ls': { options: opts(...json) },
            },
          },
          edit: {
            options: opts(
              '--accept-visibility-change-consequences',
              '--add-topic=',
              '--allow-forking',
              '--allow-update-branch',
              '--default-branch=',
              '--delete-branch-on-merge',
              '-d= --description=',
              '--enable-advanced-security',
              '--enable-auto-merge',
              '--enable-discussions',
              '--enable-issues',
              '--enable-merge-commit',
              '--enable-projects',
              '--enable-rebase-merge',
              '--enable-secret-scanning',
              '--enable-secret-scanning-push-protection',
              '--enable-squash-merge',
              '--enable-wiki',
              '-h= --homepage=',
              '--remove-topic=',
              '--squash-merge-commit-message=',
              '--template',
              '--visibility=',
            ),
          },
          fork: {
            options: opts(
              '--clone',
              '--default-branch-only',
              '--fork-name=',
              '--org=',
              o('--remote', { effects: ['fs:write'] }),
              '--remote-name=',
            ),
            finish: finishFork,
          },
          gitignore: {
            subcommands: {
              'list|ls': {},
              view: {},
            },
          },
          license: {
            subcommands: {
              'list|ls': {},
              view: { options: opts('-w --web') },
            },
          },
          'list|ls': {
            options: opts(
              '--archived',
              '--fork',
              '-l= --language=',
              '-L= --limit=',
              '--no-archived',
              '--source',
              '--topic=',
              '--visibility=',
              ...json,
            ),
          },
          'read-dir': { options: opts('--ref=', ...json) },
          'read-file': { options: opts('--allow-escape-sequences', '--clobber', o('-o= --output=', { role: 'write' }), '--ref=', ...json) },
          rename: { effects: ['fs:write'], options: opts('-y --yes') },
          'set-default': { effects: ['fs:write'], options: opts('-u --unset', '-v --view') },
          sync: { effects: hooks, options: opts('-b= --branch=', '--force', '-s= --source=') },
          unarchive: { options: opts('-y --yes') },
          view: { options: opts('-b= --branch=', '-w --web', ...json) },
        },
      },
      'ruleset|rs': {
        effects: ['network'],
        options: opts('-R= --repo='),
        subcommands: {
          check: { options: opts('--default', '-w --web') },
          'list|ls': { options: opts('-L= --limit=', '-o= --org=', '-p --parents', '-w --web') },
          view: { options: opts('-o= --org=', '-p --parents', '-w --web') },
        },
      },
      run: {
        effects: ['network'],
        options: opts('-R= --repo='),
        subcommands: {
          cancel: { options: opts('--force') },
          delete: {},
          download: { effects: ['fs:write'], options: opts(o('-D= --dir=', { role: 'write' }), '-n= --name=', '-p= --pattern=') },
          'list|ls': {
            options: opts(
              '-a --all',
              '-b= --branch=',
              '-c= --commit=',
              '--created=',
              '-e= --event=',
              '-L= --limit=',
              '-s= --status=',
              '-u= --user=',
              '-w= --workflow=',
              ...json,
            ),
          },
          rerun: { options: opts('-d --debug', '--failed', '-j= --job=') },
          view: {
            options: opts('-a= --attempt=', '--exit-status', '-j= --job=', '--log', '--log-failed', '-v --verbose', '-w --web', ...json),
          },
          watch: { options: opts('--compact', '--exit-status', '-i= --interval=') },
        },
      },
      search: {
        effects: ['network'],
        subcommands: {
          code: {
            options: opts(
              '--extension=',
              '--filename=',
              '--language=',
              '-L= --limit=',
              '--match=',
              '--owner=',
              '-R= --repo=',
              '--size=',
              '-w --web',
              ...json,
            ),
          },
          commits: {
            options: opts(
              '--author=',
              '--author-date=',
              '--author-email=',
              '--author-name=',
              '--committer=',
              '--committer-date=',
              '--committer-email=',
              '--committer-name=',
              '--hash=',
              '-L= --limit=',
              '--merge',
              '--order=',
              '--owner=',
              '--parent=',
              '-R= --repo=',
              '--sort=',
              '--tree=',
              '--visibility=',
              '-w --web',
              ...json,
            ),
          },
          issues: {
            options: opts(
              '--app=',
              '--archived',
              '--assignee=',
              '--author=',
              '--closed=',
              '--commenter=',
              '--comments=',
              '--created=',
              '--include-prs',
              '--interactions=',
              '--involves=',
              '--label=',
              '--language=',
              '-L= --limit=',
              '--locked',
              '--match=',
              '--mentions=',
              '--milestone=',
              '--no-assignee',
              '--no-label',
              '--no-milestone',
              '--no-project',
              '--order=',
              '--owner=',
              '--project=',
              '--reactions=',
              '-R= --repo=',
              '--sort=',
              '--state=',
              '--team-mentions=',
              '--updated=',
              '--visibility=',
              '-w --web',
              ...json,
            ),
          },
          prs: {
            options: opts(
              '--app=',
              '--archived',
              '--assignee=',
              '--author=',
              '-B= --base=',
              '--checks=',
              '--closed=',
              '--commenter=',
              '--comments=',
              '--created=',
              '--draft',
              '-H= --head=',
              '--interactions=',
              '--involves=',
              '--label=',
              '--language=',
              '-L= --limit=',
              '--locked',
              '--match=',
              '--mentions=',
              '--merged',
              '--merged-at=',
              '--milestone=',
              '--no-assignee',
              '--no-label',
              '--no-milestone',
              '--no-project',
              '--order=',
              '--owner=',
              '--project=',
              '--reactions=',
              '-R= --repo=',
              '--review=',
              '--review-requested=',
              '--reviewed-by=',
              '--sort=',
              '--state=',
              '--team-mentions=',
              '--updated=',
              '--visibility=',
              '-w --web',
              ...json,
            ),
          },
          repos: {
            options: opts(
              '--archived',
              '--created=',
              '--followers=',
              '--forks=',
              '--good-first-issues=',
              '--help-wanted-issues=',
              '--include-forks=',
              '--language=',
              '--license=',
              '-L= --limit=',
              '--match=',
              '--number-topics=',
              '--order=',
              '--owner=',
              '--size=',
              '--sort=',
              '--stars=',
              '--topic=',
              '--updated=',
              '--visibility=',
              '-w --web',
              ...json,
            ),
          },
        },
      },
      secret: {
        effects: ['network'],
        options: opts('-R= --repo='),
        subcommands: {
          'delete|remove': { options: opts('-a= --app=', '-e= --env=', '-o= --org=', '-u --user') },
          'list|ls': { options: opts('-a= --app=', '-e= --env=', '-o= --org=', '-u --user', ...json) },
          set: {
            options: opts(
              '-a= --app=',
              '-b= --body=',
              '-e= --env=',
              o('-f= --env-file=', { role: 'read' }),
              '--no-repos-selected',
              '--no-store',
              '-o= --org=',
              '-r= --repos=',
              '-u --user',
              '-v= --visibility=',
            ),
          },
        },
      },
      'skill|skills': {
        subcommands: {
          'install|add': {
            effects: ['network', 'fs:write'],
            options: opts(
              '--agent=',
              '--all',
              '--allow-hidden-dirs',
              o('--dir=', { role: 'write' }),
              '-f --force',
              '--from-local',
              '--pin=',
              '--scope=',
              '--upstream',
            ),
          },
          'list|ls': { options: opts('--agent=', '--dir=', '--scope=', ...json) },
          'preview|show': { effects: ['network'], options: opts('--allow-hidden-dirs') },
          publish: { effects: ['network'], options: opts('--dry-run', '--fix', '--tag=') },
          search: { effects: ['network'], options: opts('-L= --limit=', '--owner=', '--page=', ...json) },
          update: { effects: ['network', 'fs:write'], options: opts('--all', '--dir=', '--dry-run', '--force', '--unpin') },
        },
      },
      'ssh-key': {
        effects: ['network'],
        subcommands: {
          add: { positionals: 'read', options: opts('-t= --title=', '--type=') },
          delete: { options: opts('-y --yes') },
          'list|ls': {},
        },
      },
      status: { effects: ['network'], options: opts('-e= --exclude=', '-o= --org=') },
      variable: {
        effects: ['network'],
        options: opts('-R= --repo='),
        subcommands: {
          'delete|remove': { options: opts('-e= --env=', '-o= --org=') },
          get: { options: opts('-e= --env=', '-o= --org=', ...json) },
          'list|ls': { options: opts('-e= --env=', '-o= --org=', ...json) },
          set: {
            options: opts(
              '-b= --body=',
              '-e= --env=',
              o('-f= --env-file=', { role: 'read' }),
              '-o= --org=',
              '-r= --repos=',
              '-v= --visibility=',
            ),
          },
        },
      },
      version: {},
      workflow: {
        effects: ['network'],
        options: opts('-R= --repo='),
        subcommands: {
          disable: {},
          enable: {},
          'list|ls': { options: opts('-a --all', '-L= --limit=', ...json) },
          run: { options: opts('-F= --field=', '--json', '-f= --raw-field=', '-r= --ref='), finish: finishFields },
          view: { options: opts('-r= --ref=', '-w --web', '-y --yaml') },
        },
      },
    },
  }),
  parse: (args, parsed) => readCobra(gh, args, parsed),
  finish: finishGh,
};

/** `find`: starting points, then an expression whose actions run commands, delete and write files. */
const findActions = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const findTakesOne = new Set(
  '-name -iname -path -ipath -wholename -iwholename -regex -iregex -regextype -type -xtype -newer -anewer -cnewer -size -mtime -mmin -atime -amin -ctime -cmin -user -group -uid -gid -perm -maxdepth -mindepth -inum -links -samefile -used -lname -ilname -printf -fstype -context -newerXY'.split(
    ' ',
  ),
);

const find: CommandSpec = {
  effects: ['fs:read'],
  options: opts(
    o('-delete', { effects: ['fs:delete'] }),
    ...[...findActions].map((name) => o(name, { effects: ['exec:arbitrary'] })),
    o('-fprint -fprint0 -fls -fprintf', { effects: ['fs:write'] }),
  ),
  parse(args, parsed) {
    let i = 0;
    for (; i < args.length; i++) {
      const value = staticValue(args[i]);
      if (value === '-D' || value === '-O') i++;
      else if (value === undefined || !/^-([HLP]|O\d+)$/.test(value)) break;
    }
    const starts: Arg[] = [];
    for (; i < args.length; i++) {
      const arg = args[i]!;
      const value = staticValue(arg);
      if (value !== undefined && (value.startsWith('-') || value === '(' || value === '!' || value === ',')) break;
      if (value === undefined) parsed.maybeOptions = true;
      starts.push(arg);
    }
    if (starts.length === 0) starts.push({ kind: 'static', value: '.' });
    parsed.positionals.push(...starts);
    parsed.reads.push(...starts);
    for (; i < args.length; i++) {
      const arg = args[i]!;
      const value = staticValue(arg);
      if (value === undefined) {
        parsed.maybeOptions = true;
        continue;
      }
      if (!value.startsWith('-')) continue;
      const add = (name: string, optionValue: Arg | true = true) => (parsed.options[name] ??= []).push(optionValue);
      if (findActions.has(value)) {
        let end = i + 1;
        while (
          end < args.length &&
          !(staticValue(args[end]) === ';' || (staticValue(args[end]) === '+' && staticValue(args[end - 1]) === '{}'))
        )
          end++;
        const argv = args.slice(i + 1, end).map((word): Arg => {
          const text = staticValue(word);
          return text?.includes('{}')
            ? { kind: 'dynamic', text, reason: 'placeholder', split: false, prefix: text.slice(0, text.indexOf('{}')) }
            : word;
        });
        // The command it runs is an invocation of its own, judged on its own; `exec:arbitrary` on the options is
        // only for a dynamic word that may be one of them.
        if (argv.length > 0) parsed.nested.push({ argv, open: false });
        add(value);
        i = end;
      } else if (value === '-delete') {
        add(value);
        parsed.effects.add('fs:delete');
        parsed.writes.push(...starts);
      } else if (value === '-fprint' || value === '-fprint0' || value === '-fls' || value === '-fprintf') {
        const target = args[i + 1];
        if (target) parsed.writes.push(target);
        parsed.effects.add('fs:write');
        add(value, target ?? true);
        i += value === '-fprintf' ? 2 : 1;
      } else if (findTakesOne.has(value)) {
        add(value, args[i + 1] ?? true);
        i++;
      } else {
        add(value);
      }
    }
  },
};

/** `cp`: the last positional is written, the others read. `mv` writes (and so removes) all of them. */
const copy = (all: boolean): CommandSpec => ({
  abbreviations: true,
  effects: ['fs:write'],
  options: opts(
    o('-t= --target-directory=', { role: 'write' }),
    '-r -R --recursive',
    '-f --force',
    '-i --interactive',
    '-n --no-clobber',
    '-b --backup=?',
    '-S= --suffix=',
    '-T --no-target-directory',
    '-u --update=?',
    '-v --verbose',
    '-a --archive',
    '-p',
    '--preserve=?',
    '-l --link',
    '-s --symbolic-link',
  ),
  finish(parsed) {
    const targets = parsed.options['--target-directory'] ? [] : parsed.positionals.slice(-1);
    const sources = parsed.options['--target-directory'] ? parsed.positionals : parsed.positionals.slice(0, -1);
    parsed.writes.push(...targets, ...(all ? sources : []));
    parsed.reads.push(...sources);
  },
});

/** `chmod mode file…`: the first positional isn't a path. */
const ownership: CommandSpec = {
  abbreviations: true,
  effects: ['fs:write'],
  options: opts('-R --recursive', '-v --verbose', '-c --changes', '-f --silent --quiet', '--reference=', '-h --no-dereference'),
  finish(parsed) {
    parsed.writes.push(...parsed.positionals.slice(parsed.options['--reference'] ? 0 : 1));
  },
};

/** Programs by name, aliases after `|`. */
const programs: Record<string, CommandSpec> = {
  'bash|sh|dash|ksh|mksh|ash|busybox-sh': shell,
  // Shells whose code isn't Bash (zsh's glob qualifiers run code, fish and PowerShell are other languages): their code
  // is code the analysis can't see into, never parsed as Bash.
  'zsh|csh|tcsh': interpreter(opts(inline('-c'), '-i', '-l --login', '-f --no-rcs', '-e', '-x', '-v', '-n', '-o=')),
  fish: interpreter(
    opts(
      inline('-c= --command='),
      inline('-C= --init-command='),
      '-i --interactive',
      '-l --login',
      '-n --no-execute',
      '-N --no-config',
      '-P --private',
    ),
  ),
  'pwsh|powershell|pwsh.exe|powershell.exe|cmd|cmd.exe|nu|xonsh|elvish': { effects: ['exec:arbitrary'] },
  sudo: {
    posix: true,
    effects: ['privilege'],
    command: { assignments: true },
    options: opts(
      '-u= --user=',
      '-g= --group=',
      '-E --preserve-env=?',
      '-H --set-home',
      '-i --login',
      '-s --shell',
      '-n --non-interactive',
      '-k --reset-timestamp',
      '-b --background',
      o('-D= --chdir=', { role: 'cwd' }),
      '-C= --close-from=',
      '-p= --prompt=',
      '-r= --role=',
      '-t= --type=',
      '-U= --other-user=',
      '-l --list',
      '-v --validate',
      '-A --askpass',
      '-S --stdin',
      '-P --preserve-groups',
      '-e --edit',
    ),
  },
  doas: { posix: true, effects: ['privilege'], command: {}, options: opts('-u=', '-s', '-n', o('-C=', { role: 'read' })) },
  su: {
    effects: ['privilege'],
    options: opts(o('-c= --command=', { role: 'script' }), '-l --login', '-s= --shell=', '-m -p --preserve-environment', '-g= --group='),
  },
  env: {
    posix: true,
    command: { assignments: true },
    options: opts(
      '-i --ignore-environment',
      '-u= --unset=',
      o('-C= --chdir=', { role: 'cwd' }),
      o('-S= --split-string=', { role: 'argv' }),
      '-0 --null',
      '-v --debug',
      '--block-signal=?',
      '--default-signal=?',
      '--ignore-signal=?',
    ),
  },
  nice: { posix: true, command: {}, options: opts('-n= --adjustment=') },
  nohup: { posix: true, command: {} },
  timeout: {
    posix: true,
    command: { skip: 1 },
    options: opts('-s= --signal=', '-k= --kill-after=', '--preserve-status', '--foreground', '-v --verbose'),
  },
  stdbuf: { posix: true, command: {}, options: opts('-i= --input=', '-o= --output=', '-e= --error=') },
  time: {
    posix: true,
    command: {},
    options: opts(o('-o= --output=', { role: 'write' }), '-f= --format=', '-a --append', '-p --portability', '-v --verbose', '-q --quiet'),
  },
  chroot: { posix: true, effects: ['privilege'], command: { skip: 1 }, options: opts('--userspec=', '--groups=', '--skip-chdir') },
  xargs: {
    posix: true,
    command: { open: true, fallback: 'echo' },
    options: opts(
      '-0 --null',
      o('-a= --arg-file=', { role: 'read' }),
      '-d= --delimiter=',
      '-E=',
      '-e --eof=?',
      '-I=',
      '-i --replace=?',
      '-L= --max-lines=',
      '-l=?',
      '-n= --max-args=',
      '-P= --max-procs=',
      '-p --interactive',
      '-r --no-run-if-empty',
      '-s= --max-chars=',
      '-t --verbose',
      '-x --exit',
      '-o --open-tty',
      '--process-slot-var=',
    ),
  },
  watch: {
    posix: true,
    options: opts(
      '-n= --interval=',
      '-d --differences=?',
      '-t --no-title',
      '-b --beep',
      '-e --errexit',
      '-g --chgexit',
      '-c --color',
      '-x --exec',
      '-p --precise',
      '-w --no-wrap',
      '-q= --equexit=',
    ),
    finish(parsed) {
      if (parsed.positionals.length === 0) return;
      if (parsed.options['--exec']) {
        parsed.nested.push({ argv: parsed.positionals, open: false });
        return;
      }
      const dynamic = parsed.positionals.find((arg) => arg.kind === 'dynamic');
      parsed.scripts.push(dynamic ?? { kind: 'static', value: parsed.positionals.map((arg) => staticValue(arg)).join(' ') });
    },
  },
  ssh: {
    posix: true,
    effects: ['network'],
    options: sshOptions,
    finish: (parsed) => sshRuns(parsed.options, parsed.positionals.slice(1), parsed),
  },
  setsid: { posix: true, command: {}, options: opts('-w --wait', '-f --fork', '-c --ctty') },
  strace: {
    posix: true,
    command: {},
    options: opts(
      '-f --follow-forks',
      '-c --summary',
      '-C --summary-only',
      '-q --quiet',
      '-r --relative-timestamps',
      '-t --absolute-timestamps',
      '-T --syscall-times',
      '-v --verbose',
      '-x --strings-in-hex',
      '-xx --strings-in-hex-all',
      '-y --decode-fds',
      '-yy --decode-fds',
      o('-e=', { role: 'read' }),
      o('-o= --output=', { role: 'write' }),
      '-p= --attach=',
      '-s= --string-limit=',
      '-u= --user=',
      '-E= --env=',
      '-I= --interruptible=',
      '-b= --detach-on=',
      '-P= --trace-path=',
    ),
  },
  unshare: {
    posix: true,
    command: {},
    options: opts(
      '-m --mount',
      '-u --uts',
      '-i --ipc',
      '-n --net',
      '-p --pid',
      '-U --user',
      '-C --cgroup',
      '-T --time',
      '-f --fork',
      '-r --map-root-user',
      '--mount-proc',
      '--propagation=',
      '-S= --setuid=',
      '-G= --setgid=',
      '--keep-caps',
      '--kill-child=?',
    ),
  },
  ionice: { posix: true, command: {}, options: opts('-c= --class=', '-n= --classdata=', '-p= --pid=', '-P= --pgid=', '-u= --uid=') },
  // `chrt -p` and `taskset -p` change a running process: there's no command. `taskset -c` reads the mask as a list; it's still a positional.
  chrt: {
    posix: true,
    command: { skip: 1 },
    options: opts(
      '-f --fifo',
      '-r --rr',
      '-o --other',
      '-b --batch',
      '-i --idle',
      '-d --deadline',
      '-p --pid',
      '-R --reset-on-fork',
      '-m --max',
      '-a --all-tasks',
      '-v --verbose',
    ),
    finish: noCommandWithPid,
  },
  taskset: { posix: true, command: { skip: 1 }, options: opts('-c --cpu-list', '-p --pid', '-a --all-tasks'), finish: noCommandWithPid },
  flock: {
    posix: true,
    command: { skip: 1 },
    options: opts(
      '-n --nb --nonblock',
      '-s --shared',
      '-x -e --exclusive',
      '-u --unlock',
      '-o --close',
      '-F --no-fork',
      '--verbose',
      '--fcntl',
      '-w= --wait= --timeout=',
      '-E= --conflict-exit-code=',
      o('-c= --command=', { role: 'script' }),
    ),
    finish(parsed) {
      // `flock FILE -c CODE`: -c after the lock file gives shell code, not a program.
      const [nested] = parsed.nested;
      const first = nested?.argv[0];
      if (first?.kind !== 'static' || (first.value !== '-c' && first.value !== '--command')) return;
      parsed.nested = [];
      if (nested!.argv[1]) parsed.scripts.push(nested!.argv[1]);
    },
  },
  script: {
    options: opts(
      o('-c= --command=', { role: 'script' }),
      '-q --quiet',
      '-e --return',
      '-f --flush',
      '-a --append',
      '-E= --echo=',
      '-m= --logging-format=',
      '-o= --output-limit=',
      o('-t=? --timing=?', { role: 'write' }),
      o('-T= --log-timing=', { role: 'write' }),
      o('-I= --log-in=', { role: 'write' }),
      o('-O= --log-out=', { role: 'write' }),
      o('-B= --log-io=', { role: 'write' }),
    ),
    finish(parsed) {
      // Without -c, it starts an interactive shell. The positional is where the session is logged.
      if (!parsed.options['--command']) parsed.effects.add('exec:arbitrary');
      const log = parsed.positionals[0];
      if (log && staticValue(log) !== '/dev/null') parsed.writes.push(log);
      if (parsed.writes.length > 0) parsed.effects.add('fs:write');
    },
  },
  busybox: {
    posix: true,
    command: {},
  },
  'python|python3|python2': interpreter(
    opts(inline('-c='), o('-m=', { effects: ['exec:project'] }), '-B', '-E', '-I', '-O', '-q', '-s', '-S', '-u', '-v', '-x', '-W=', '-X='),
  ),
  'node|nodejs': interpreter(
    opts(
      inline('-e= --eval='),
      inline('-p= --print='),
      o('-r= --require=', { effects: ['exec:file'] }),
      o('--import=', { effects: ['exec:file'] }),
      '-c --check',
      '-i --interactive',
      '--test',
      '--watch',
      '--input-type=',
    ),
  ),
  perl: interpreter(
    opts(
      inline('-e='),
      inline('-E='),
      '-n',
      '-p',
      o('-i=?', { effects: ['fs:write'] }),
      '-l=?',
      '-a',
      '-F=?',
      '-M=?',
      '-m=?',
      '-I=?',
      '-w',
      '-W',
      '-s',
      '-x=?',
      '-0=?',
    ),
  ),
  ruby: interpreter(opts(inline('-e='), '-n', '-p', o('-i=?', { effects: ['fs:write'] }), '-r=', '-I=', '-w', '-W=?')),
  npm: {
    options: opts(o('--prefix= -C', { role: 'cwd' }), '-w= --workspace=', '-g --global', '-s --silent', '-y --yes'),
    subcommands: {
      ...each('run|run-script|rum|urn test|t|tst start stop restart', { effects: ['exec:project'] }),
      ...each(
        'install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add ci|clean-install|ic|install-clean|isntall-clean update|up|upgrade|udpate rebuild|rb',
        { effects: ['network', 'fs:write', 'exec:project'] },
      ),
      ...each('exec|x init|create|innit', { effects: ['network', 'exec:arbitrary'] }),
      'uninstall|unlink|remove|rm|r|un': { effects: ['fs:write'] },
      ...each('publish unpublish deprecate dist-tag|dist-tags owner|author access team login logout adduser|add-user', {
        effects: ['network'],
      }),
      ...each('audit outdated view|info|show|v search|find|s|se', { effects: ['network'] }),
      ...each('ls|list ll|la config|c get set pkg prefix root bin help|hlep version|verison explain|why doctor', {}),
    },
  },
  npx: {
    posix: true,
    effects: ['network', 'exec:arbitrary'],
    options: opts('-p= --package=', o('-c= --call=', { role: 'script' }), '-y --yes', '--no'),
  },
  make: {
    effects: ['exec:project'],
    options: opts(
      o('-C= --directory=', { role: 'cwd' }),
      o('-f= --file= --makefile=', { role: 'read' }),
      '-j --jobs=?',
      '-k --keep-going',
      '-n --just-print --dry-run',
      '-s --silent',
      '-B --always-make',
      '-e',
    ),
  },
  tar: {
    effects: ['fs:read'],
    options: opts(
      '-f= --file=',
      o('-C= --directory=', { role: 'cwd' }),
      o('-I= --use-compress-program=', { effects: ['exec:arbitrary'] }),
      o('--to-command=', { effects: ['exec:arbitrary'] }),
      o('--checkpoint-action=', { effects: ['exec:arbitrary'] }),
      o('-F= --info-script=', { effects: ['exec:arbitrary'] }),
      o('--info-script=', { effects: ['exec:arbitrary'] }),
      o('--transform=', { effects: ['exec:arbitrary'] }),
      o('--exclude-from=', { role: 'read' }),
      o('-T= --files-from=', { role: 'read' }),
      ...'-x --extract --get -c --create -t --list -v --verbose -z --gzip -j --bzip2 -J --xz -p --preserve-permissions -P --absolute-names -k --keep-old-files -O --to-stdout'
        .split(' ')
        .map((name) => o(name)),
    ),
    finish(parsed) {
      const oldMode = parsed.positionals[0]?.kind === 'static' ? parsed.positionals[0].value : '';
      const mode = `${oldMode}${Object.keys(parsed.options).join(' ')}`;
      const extracting = /(?:\bx\b|^[a-zA-Z]*x[a-zA-Z]*$)|--extract|--get/.test(mode);
      const creating = /(?:\bc\b|^[a-zA-Z]*c[a-zA-Z]*$)|--create/.test(mode);
      const archive = parsed.options['--file']?.[0] ?? (oldMode ? parsed.positionals[1] : undefined);
      if (archive !== undefined && archive !== true) {
        if (creating) {
          parsed.writes.push(archive);
          parsed.effects.add('fs:write');
        } else {
          parsed.reads.push(archive);
        }
      }
      if (extracting) {
        parsed.effects.add('fs:write');
        parsed.writes.push({ kind: 'dynamic', text: 'tar extraction path', reason: 'placeholder', split: true, prefix: '' });
      }
      if (parsed.positionals.some((arg) => arg.kind === 'dynamic')) parsed.maybeOptions = true;
    },
  },
  rsync: {
    effects: ['fs:write', 'network'],
    options: opts(
      o('-e= --rsh=', { effects: ['exec:arbitrary'] }),
      o('--rsync-path=', { effects: ['exec:arbitrary'] }),
      o('--files-from=', { role: 'read' }),
      o('--exclude-from=', { role: 'read' }),
      o('--include-from=', { role: 'read' }),
      o('--backup-dir=', { role: 'write' }),
      o('--log-file=', { role: 'write' }),
      ...'-a --archive -r --recursive -v --verbose -n --dry-run -d --dirs -l --links -t --times -p --perms -g --group -o --owner -D --devices -z --compress -e --rsh -P --partial'
        .split(' ')
        .map((name) => o(name)),
    ),
    finish(parsed) {
      parsed.writes.push({ kind: 'dynamic', text: 'rsync destination', reason: 'placeholder', split: false, prefix: '' });
    },
  },
  vim: {
    options: opts(
      o('-c= --cmd=', { effects: ['exec:arbitrary'] }),
      o('-S=', { role: 'read', effects: ['exec:file'] }),
      '-R --readonly',
      '-M',
      '-u=',
      '-U=',
    ),
    finish(parsed) {
      if (parsed.positionals.some((arg) => arg.kind === 'dynamic' || (arg.kind === 'static' && arg.value.startsWith('+'))))
        parsed.effects.add('exec:arbitrary');
    },
  },
  zip: {
    effects: ['fs:write'],
    options: opts(o('-T', { effects: ['exec:arbitrary'] }), '-r --recurse-paths', '-q --quiet', '-v --verbose', '-j --junk-paths'),
    finish(parsed) {
      if (parsed.positionals[0]) parsed.writes.push(parsed.positionals[0]);
    },
  },
  sed: {
    effects: ['fs:read'],
    positionals: 'read',
    options: opts(
      o('-e= --expression='),
      o('-f= --file=', { role: 'read' }),
      o('-i=? --in-place=?', { effects: ['fs:write'] }),
      '-n --quiet --silent',
      '-E --regexp-extended',
      '-r',
      '-s --separate',
      '-u --unbuffered',
      '--sandbox',
    ),
    finish(parsed) {
      for (const script of [...(parsed.options['--expression'] ?? []), ...parsed.positionals]) {
        if (script === true) continue;
        if (script.kind === 'dynamic') {
          parsed.maybeOptions = true;
          continue;
        }
        if (/(?:^|;)\s*(?:e|s[\s\S]*?\/[gIpMw]*e)(?:\s|;|$)/.test(script.value)) parsed.effects.add('exec:arbitrary');
        for (const match of script.value.matchAll(/(?:^|;)\s*[wW]\s+([^;\s]+)/g)) {
          parsed.writes.push({ kind: 'static', value: match[1]! });
          parsed.effects.add('fs:write');
        }
      }
      if (parsed.options['--in-place'] || parsed.options['-i']) {
        const inputs = parsed.options['--expression'] || parsed.options['--file'] ? parsed.positionals : parsed.positionals.slice(1);
        parsed.writes.push(...inputs);
        parsed.effects.add('fs:write');
      }
      if (!parsed.options['--expression'] && !parsed.options['--file'] && parsed.positionals.length > 0)
        parsed.reads = parsed.reads.filter((arg) => arg !== parsed.positionals[0]);
    },
  },
  awk: {
    effects: ['fs:read'],
    options: opts(
      o('-f=', { role: 'read', effects: ['exec:project'] }),
      o('-e=', { effects: ['exec:arbitrary'] }),
      o('-F=', {}),
      o('-v=', {}),
      o('-l=', { effects: ['exec:project'] }),
      '--posix',
      '--sandbox',
      '-safe',
    ),
    finish(parsed) {
      const code = [...(parsed.options['-e'] ?? []), ...parsed.positionals]
        .map((arg) => (arg === true ? '' : (staticValue(arg) ?? '')))
        .join('\n');
      if (/\bsystem\s*\(|\|(?:\s*getline|[^;]*$)|(?:print|printf)[^;\n]*>>?\s*[^=]/.test(code)) parsed.effects.add('exec:arbitrary');
      if (code.includes('@load')) parsed.effects.add('exec:project');
      for (const match of code.matchAll(/(?:print|printf)\b[^;\n]*?(?:>>|>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))/g)) {
        const target = match[1] ?? match[2];
        parsed.writes.push(
          target
            ? { kind: 'static', value: target }
            : { kind: 'dynamic', text: `awk output ${match[3] ?? ''}`, reason: 'variable', split: false, prefix: '' },
        );
        parsed.effects.add('fs:write');
      }
      if ([...(parsed.options['-f'] ?? []), ...(parsed.options['-l'] ?? [])].some((arg) => arg !== true && arg.kind === 'dynamic'))
        parsed.maybeOptions = true;
    },
  },
  uniq: {
    ...reader(
      '-c --count',
      '-d --repeated',
      '-u --unique',
      '-i --ignore-case',
      '-f= --skip-fields=',
      '-s= --skip-chars=',
      '-w= --check-chars=',
    ),
    options: opts(
      '-c --count',
      '-d --repeated',
      '-u --unique',
      '-i --ignore-case',
      '-f= --skip-fields=',
      '-s= --skip-chars=',
      '-w= --check-chars=',
    ),
    finish(parsed) {
      const output = parsed.positionals[1];
      if (output) {
        parsed.reads = parsed.reads.filter((arg) => arg !== output);
        parsed.writes.push(output);
        parsed.effects.add('fs:write');
      }
    },
  },
  xxd: {
    ...reader(
      '-a --autoskip',
      '-b --bits',
      '-c= --cols=',
      '-g= --groupsize=',
      '-l= --len=',
      '-s= --seek=',
      '-u --uppercase',
      '-p --postscript',
      '-r --revert',
    ),
    options: opts(
      '-a --autoskip',
      '-b --bits',
      '-c= --cols=',
      '-g= --groupsize=',
      '-l= --len=',
      '-s= --seek=',
      '-u --uppercase',
      '-p --postscript',
      '-r --revert',
    ),
    finish(parsed) {
      const output = parsed.positionals[1];
      if (output) {
        parsed.reads = parsed.reads.filter((arg) => arg !== output);
        parsed.writes.push(output);
        parsed.effects.add('fs:write');
      }
    },
  },
  tree: {
    ...reader(
      '-d --dirs-only',
      '-L= --level=',
      '-a --all',
      '-f --full-path',
      '-h --human-readable',
      '-i --no-indent',
      '-p --permissions',
      '-u --owner',
      '-g --group',
      '-s --size',
      '-D --date',
    ),
    options: opts(
      '-d --dirs-only',
      '-L= --level=',
      '-a --all',
      '-f --full-path',
      '-h --human-readable',
      '-i --no-indent',
      '-p --permissions',
      '-u --owner',
      '-g --group',
      '-s --size',
      '-D --date',
      o('-o= --output=', { role: 'write', effects: ['fs:write'] }),
    ),
  },
  date: {
    options: opts(
      o('-f= --file=', { role: 'read' }),
      o('-s= --set=', { effects: ['privilege'] }),
      '-u --utc',
      '-R --rfc-email',
      '-I=? --iso-8601=?',
      '--debug',
      '--date=',
      '--reference=',
    ),
  },
  hostname: {
    options: opts('-f --fqdn', '-s --short', '-d --domain', '-y --yp', '-i --ip-address', '-I --all-ip-addresses', '-A --all-fqdns'),
    finish(parsed) {
      if (parsed.positionals.length > 0) parsed.effects.add('privilege');
    },
  },
  rm: writer(
    'fs:delete',
    '-f --force',
    '-i',
    '-I',
    '--interactive=?',
    '-r -R --recursive',
    '-d --dir',
    '-v --verbose',
    '--one-file-system',
    '--no-preserve-root',
    '--preserve-root=?',
  ),
  'rmdir|unlink|shred': writer(
    'fs:delete',
    '-p --parents',
    '-v --verbose',
    '-u --remove=?',
    '-z --zero',
    '-n= --iterations=',
    '-f --force',
  ),
  'mkdir|touch|truncate': writer(
    'fs:write',
    '-p --parents',
    '-m= --mode=',
    '-v --verbose',
    '-s= --size=',
    '-r= --reference=',
    '-d= --date=',
    '-t=',
    '-a',
    '-c --no-create',
  ),
  tee: writer('fs:write', '-a --append', '-i --ignore-interrupts', '-p', '--output-error=?'),
  cp: copy(false),
  mv: copy(true),
  ln: { ...copy(false), effects: ['fs:write'] },
  'chmod|chown|chgrp': ownership,
  dd: {
    effects: ['fs:read'],
    finish(parsed) {
      for (const arg of parsed.positionals) {
        const value = staticValue(arg) ?? '';
        if (value.startsWith('of=')) {
          parsed.writes.push({ kind: 'static', value: value.slice(3) });
          parsed.effects.add('fs:write');
        }
        if (value.startsWith('if=')) parsed.reads.push({ kind: 'static', value: value.slice(3) });
        if (arg.kind === 'dynamic') parsed.maybeOptions = true;
      }
    },
  },
  find,
  git,
  gh,
  curl: {
    effects: ['network'],
    options: opts(
      o('-o= --output=', { role: 'write', effects: ['fs:write'] }),
      o('-O --remote-name', { effects: ['fs:write'] }),
      o('--output-dir=', { role: 'write' }),
      o('-K= --config=', { role: 'read', effects: ['fs:write'] }),
      o('-T= --upload-file=', { role: 'read' }),
      o('-c= --cookie-jar=', { role: 'write', effects: ['fs:write'] }),
      o('-D= --dump-header=', { role: 'write', effects: ['fs:write'] }),
      o('--trace= --trace-ascii=', { role: 'write', effects: ['fs:write'] }),
      o('-E= --cert=', { role: 'read' }),
      o('--key=', { role: 'read' }),
      o('--cacert=', { role: 'read' }),
      ...'-d= --data= --data-binary= --data-raw= --data-urlencode= --json= -F= --form= -H= --header= -X= --request= -u= --user= -A= --user-agent= -e= --referer= -b= --cookie= -x= --proxy= -m= --max-time= --connect-timeout= -w= --write-out= -r= --range= -C= --continue-at= --retry= -z= --time-cond= --url='
        .split(' ')
        .map((name) => o(name)),
      ...'-L --location -s --silent -S --show-error -f --fail -k --insecure -I --head -i --include -v --verbose -g --globoff -N --no-buffer -G --get --compressed'
        .split(' ')
        .map((name) => o(name)),
    ),
  },
  wget: {
    abbreviations: true,
    effects: ['network', 'fs:write'],
    options: opts(
      o('-O= --output-document=', { role: 'write' }),
      o('-P= --directory-prefix=', { role: 'write' }),
      o('-o= --output-file=', { role: 'write' }),
      o('-a= --append-output=', { role: 'write' }),
      o('-i= --input-file=', { role: 'read' }),
      o('--post-file=', { role: 'read' }),
      o('-e= --execute=', { effects: ['exec:arbitrary'] }),
      '-q --quiet',
      '-c --continue',
      '-r --recursive',
      '-U= --user-agent=',
      '--header=',
      '-t= --tries=',
      '-T= --timeout=',
    ),
  },
  'cat|less|more|wc|stat|file|nl|od|strings|md5sum|sha1sum|sha256sum|sha512sum|cmp|tac|rev|base64': reader(
    '-n',
    '-c',
    '-l',
    '-w',
    '-b',
    '-s',
    '-v',
    '-A',
    '-E',
    '-T',
  ),
  'head|tail': reader('-n= --lines=', '-c= --bytes=', '-f --follow=?', '-F', '-q --quiet', '-v --verbose', '-z --zero-terminated'),
  'grep|egrep|fgrep': reader(
    '-e= --regexp=',
    o('-f= --file=', { role: 'read' }),
    '-m= --max-count=',
    '-A= --after-context=',
    '-B= --before-context=',
    '-C= --context=',
    '--include=',
    '--exclude=',
    '--exclude-dir=',
    '--color=?',
    '--colour=?',
    '-r --recursive',
    '-R --dereference-recursive',
    '-i --ignore-case',
    '-v --invert-match',
    '-n --line-number',
    '-l --files-with-matches',
    '-L --files-without-match',
    '-c --count',
    '-o --only-matching',
    '-q --quiet --silent',
    '-s --no-messages',
    '-E --extended-regexp',
    '-F --fixed-strings',
    '-P --perl-regexp',
    '-w --word-regexp',
    '-x --line-regexp',
    '-H --with-filename',
    '-h --no-filename',
    '-z --null-data',
    '-a --text',
  ),
  rg: {
    ...reader(
      '-e= --regexp=',
      o('-f= --file=', { role: 'read' }),
      '-g= --glob=',
      '--iglob=',
      '-t= --type=',
      '-T= --type-not=',
      '-m= --max-count=',
      '-A= --after-context=',
      '-B= --before-context=',
      '-C= --context=',
      '-j= --threads=',
      '-M= --max-columns=',
      '--color=',
      '--max-depth= -d=',
      o('--pre=', { effects: ['exec:arbitrary'] }),
      '--pre-glob=',
      '-i --ignore-case',
      '-S --smart-case',
      '-s --case-sensitive',
      '-v --invert-match',
      '-n --line-number',
      '-N --no-line-number',
      '-l --files-with-matches',
      '-c --count',
      '-o --only-matching',
      '-F --fixed-strings',
      '-w --word-regexp',
      '-u --unrestricted',
      '--hidden',
      '--no-ignore',
      '--files',
      '--json',
      '-z --search-zip',
    ),
    abbreviations: false,
  },
  sort: reader(
    '-k= --key=',
    '-t= --field-separator=',
    '-S= --buffer-size=',
    '-T= --temporary-directory=',
    '-n --numeric-sort',
    '-r --reverse',
    '-u --unique',
    '-h --human-numeric-sort',
    '-f --ignore-case',
    '-V --version-sort',
    o('-o= --output=', { role: 'write', effects: ['fs:write'] }),
    o('--compress-program=', { effects: ['exec:arbitrary'] }),
  ),
  'cut|tr|paste|join|fold|fmt|column|expand|unexpand|diff|comm|jq|yq|du|realpath|readlink|basename|dirname': reader(
    '-d= --delimiter=',
    '-f= --fields=',
    '-c --count',
    '-L= --level=',
  ),
  ls: reader(
    '-I= --ignore=',
    '-w= --width=',
    '--color=?',
    '--sort=',
    '--time-style=',
    '--format=',
    '-a --all',
    '-A --almost-all',
    '-l',
    '-h --human-readable',
    '-R --recursive',
    '-1',
    '-t',
    '-r --reverse',
    '-S',
    '-d --directory',
    '-F --classify',
  ),
  'echo|printf|true|false|pwd|whoami|id|uname|which|seq|sleep|yes|nproc|uptime|tput|clear': {},
};

/** The spec for a program by name, or `undefined` when it has none. */
export function specFor(program: string): CommandSpec | undefined {
  return specs.get(program);
}

const specs = new Map(Object.entries(programs).flatMap(([key, spec]) => key.split('|').map((name) => [name, spec] as const)));
