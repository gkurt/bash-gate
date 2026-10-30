import type { Arg, Effect } from './types.ts';
import type { CommandSpec, OptionSpec, Parsed } from './argv.ts';

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
  return { names, ...(value ? { value } : {}), ...(value && valued.length < names.length ? { valued } : {}), ...extra };
}

/** Options from spellings, or from specs when they need more than spellings. */
function opts(...specs: (string | OptionSpec)[]): OptionSpec[] {
  return specs.map((spec) => (typeof spec === 'string' ? o(spec) : spec));
}

const staticValue = (arg: Arg | undefined) => (arg?.kind === 'static' ? arg.value : undefined);

/** A shell: `-c` runs its first positional as code, a positional alone runs that file, nothing at all runs stdin. */
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
    } else if (first) {
      parsed.effects.add('exec:file');
      parsed.reads.push(first);
    } else if (!parsed.options['-n'] && !parsed.options['--version'] && !parsed.options['--help']) {
      parsed.effects.add('exec:arbitrary');
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
      if (options.some((option) => option.effects?.length && parsed.options[option.names[0]!])) return;
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
    status: { abbreviations: true, options: opts('-s --short', '-b --branch', '--porcelain=?', '-u --untracked-files=?', '--ignored=?', '-z') },
    log: { abbreviations: true, options: opts('-n= --max-count=', '--format=?', '--pretty=?', '--author=', '--grep=', '--since=', '--until=', '--oneline', o('--output=', { role: 'write' })) },
    show: { abbreviations: true, options: opts('--format=?', '--pretty=?', '--stat=?', '--name-only', o('--output=', { role: 'write' })) },
    diff: {
      abbreviations: true,
      options: opts('--cached --staged', '--stat=?', '--name-only', '--name-status', '--no-ext-diff', o('--ext-diff', { effects: ['exec:project'] }), o('--output=', { role: 'write' })),
    },
    'blame|annotate|shortlog|reflog|describe|rev-parse|rev-list|ls-files|ls-tree|ls-remote|show-ref|cat-file|whatchanged|merge-base|name-rev|count-objects|var|check-ignore|check-attr|for-each-ref|help|version':
      { abbreviations: true },
    grep: { abbreviations: true, options: opts('-e=', '-f=', o('-O --open-files-in-pager=?', { effects: ['exec:arbitrary'] })) },
    'add|stage': { abbreviations: true, effects: ['fs:write'], options: opts('-A --all', '-u --update', '-f --force', '-p --patch', '-n --dry-run', '-N --intent-to-add', '-v --verbose') },
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
      options: opts('-r --rebase=?', '--no-rebase', '--ff-only', '--no-ff', '-f --force', '--no-verify', '-s= --strategy=', '-X= --strategy-option=', o('--upload-pack=', { effects: ['exec:arbitrary'] })),
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
      options: opts('-b=', '-B=', '-f --force', '--orphan=', '-t --track=?', '--detach', '-p --patch', '--ours', '--theirs', '-m --merge', '-q --quiet'),
    },
    switch: { abbreviations: true, effects: hooks, options: opts('-c= --create=', '-C= --force-create=', '-f --force --discard-changes', '-d --detach', '--orphan=', '-t --track=?') },
    restore: { abbreviations: true, effects: ['fs:write'], options: opts('-s= --source=', '-S --staged', '-W --worktree', '-p --patch') },
    reset: { abbreviations: true, effects: ['fs:write'], options: opts('--hard', '--soft', '--mixed', '--keep', '--merge', '-p --patch', '-q --quiet') },
    clean: { abbreviations: true, effects: ['fs:delete'], options: opts('-f --force', '-d', '-x', '-X', '-n --dry-run', '-i --interactive', '-e= --exclude=', '-q --quiet') },
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
    tag: { abbreviations: true, options: opts('-d --delete', '-f --force', '-a --annotate', '-m= --message=', o('-F= --file=', { role: 'read' }), '-s --sign', '-l --list') },
    merge: {
      abbreviations: true,
      effects: hooks,
      options: opts('--no-ff', '--ff-only', '--squash', '--abort', '--continue', '-m=', '-s= --strategy=', '-X= --strategy-option=', '--no-verify', '--allow-unrelated-histories'),
    },
    rebase: {
      abbreviations: true,
      effects: hooks,
      options: opts('-i --interactive', o('-x= --exec=', { role: 'script' }), '--onto=', '--abort', '--continue', '--skip', '--autosquash', '--root', '-s= --strategy=', '-X= --strategy-option=', '--no-verify', '--update-refs'),
    },
    'cherry-pick|revert': { abbreviations: true, effects: hooks, options: opts('-n --no-commit', '-e --edit', '-m= --mainline=', '--continue', '--abort', '-x') },
    stash: {
      abbreviations: true,
      effects: ['fs:write'],
      subcommands: {
        'push|save': { abbreviations: true, effects: ['fs:write'], options: opts('-m= --message=', '-u --include-untracked', '-a --all', '-k --keep-index', '-p --patch') },
        'pop|apply': { effects: ['fs:write'] },
        'drop|clear': { effects: ['fs:delete'] },
        'list|show': {},
        branch: { effects: ['fs:write'] },
      },
    },
    remote: { options: opts('-v --verbose'), subcommands: { 'add|remove|rm|rename|set-url|set-head|set-branches': { effects: ['fs:write'] }, 'get-url': {}, 'show|prune|update': { effects: ['network'] } } },
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
    rm: { abbreviations: true, effects: ['fs:delete'], positionals: 'delete', options: opts('-r', '-f --force', '--cached', '-n --dry-run', '-q --quiet') },
    mv: { abbreviations: true, effects: ['fs:write'], options: opts('-f --force', '-k', '-n --dry-run', '-v --verbose') },
    'apply|am': { abbreviations: true, effects: hooks },
    submodule: { effects: ['network', ...hooks] },
    worktree: { effects: ['fs:write'] },
    init: { abbreviations: true, effects: ['fs:write'], options: opts('--bare', '-b= --initial-branch=', o('--template=', { effects: ['exec:project'] })) },
    bisect: {
      effects: ['fs:write'],
      subcommands: { run: { command: {} }, 'start|bad|good|new|old|skip|reset|log|replay|visualize|view|terms': { effects: ['fs:write'] } },
    },
    'difftool|mergetool': { abbreviations: true, effects: ['exec:project'], options: opts(o('-x= --extcmd=', { role: 'script' }), '-t= --tool=', '-y --no-prompt', '-g --gui') },
    'filter-branch': {
      effects: ['fs:write'],
      options: [
        ...['--env-filter=', '--tree-filter=', '--index-filter=', '--parent-filter=', '--msg-filter=', '--commit-filter=', '--tag-name-filter='].map((name) => o(name, { role: 'script' })),
        ...opts('--subdirectory-filter=', '-f --force'),
      ],
    },
    archive: { abbreviations: true, options: opts(o('-o= --output=', { role: 'write' }), o('--remote=', { effects: ['network'] }), o('--exec=', { effects: ['exec:arbitrary'] }), '--format=', '--prefix=') },
    'format-patch': { abbreviations: true, effects: ['fs:write'], options: opts(o('-o= --output-directory=', { role: 'write' })) },
    'gc|prune|repack|fsck|maintenance|notes|update-ref|update-index|symbolic-ref|replace|sparse-checkout|lfs': { effects: ['fs:write'] },
  },
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
  options: opts(o('-delete', { effects: ['fs:delete'] }), ...[...findActions].map((name) => o(name, { effects: ['exec:arbitrary'] })), o('-fprint -fprint0 -fls -fprintf', { effects: ['fs:write'] })),
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
    if (!starts.length) starts.push({ kind: 'static', value: '.' });
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
        while (end < args.length && !(staticValue(args[end]) === ';' || (staticValue(args[end]) === '+' && staticValue(args[end - 1]) === '{}'))) end++;
        const argv = args.slice(i + 1, end).map((word): Arg => {
          const text = staticValue(word);
          return text?.includes('{}') ? { kind: 'dynamic', text, reason: 'placeholder', split: false, prefix: text.slice(0, text.indexOf('{}')) } : word;
        });
        // The command it runs is an invocation of its own, judged on its own; `exec:arbitrary` on the options is
        // only for a dynamic word that may be one of them.
        if (argv.length) parsed.nested.push({ argv, open: false });
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
  options: opts(o('-t= --target-directory=', { role: 'write' }), '-r -R --recursive', '-f --force', '-i --interactive', '-n --no-clobber', '-b --backup=?', '-S= --suffix=', '-T --no-target-directory', '-u --update=?', '-v --verbose', '-a --archive', '-p', '--preserve=?', '-l --link', '-s --symbolic-link'),
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
  fish: interpreter(opts(inline('-c= --command='), inline('-C= --init-command='), '-i --interactive', '-l --login', '-n --no-execute', '-N --no-config', '-P --private')),
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
  su: { effects: ['privilege'], options: opts(o('-c= --command=', { role: 'script' }), '-l --login', '-s= --shell=', '-m -p --preserve-environment', '-g= --group=') },
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
  timeout: { posix: true, command: { skip: 1 }, options: opts('-s= --signal=', '-k= --kill-after=', '--preserve-status', '--foreground', '-v --verbose') },
  stdbuf: { posix: true, command: {}, options: opts('-i= --input=', '-o= --output=', '-e= --error=') },
  time: { posix: true, command: {}, options: opts(o('-o= --output=', { role: 'write' }), '-f= --format=', '-a --append', '-p --portability', '-v --verbose', '-q --quiet') },
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
    options: opts('-n= --interval=', '-d --differences=?', '-t --no-title', '-b --beep', '-e --errexit', '-g --chgexit', '-c --color', '-x --exec', '-p --precise', '-w --no-wrap', '-q= --equexit='),
    finish(parsed) {
      if (!parsed.positionals.length) return;
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
    options: opts(
      ...'-b= -c= -D= -E= -e= -F= -I= -i= -J= -L= -l= -m= -O= -o= -p= -Q= -R= -S= -W= -w= -B='.split(' '),
      ...'-4 -6 -A -a -C -f -G -g -K -k -M -N -n -q -s -T -t -V -v -X -x -Y -y'.split(' '),
    ),
    finish(parsed) {
      const command = parsed.positionals.slice(1);
      if (!command.length) return;
      parsed.effects.add('exec:remote');
      const dynamic = command.find((arg) => arg.kind === 'dynamic');
      parsed.scripts.push(dynamic ?? { kind: 'static', value: command.map((arg) => staticValue(arg)).join(' ') });
    },
  },
  'python|python3|python2': interpreter(opts(inline('-c='), o('-m=', { effects: ['exec:project'] }), '-B', '-E', '-I', '-O', '-q', '-s', '-S', '-u', '-v', '-x', '-W=', '-X=')),
  'node|nodejs': interpreter(
    opts(inline('-e= --eval='), inline('-p= --print='), o('-r= --require=', { effects: ['exec:file'] }), o('--import=', { effects: ['exec:file'] }), '-c --check', '-i --interactive', '--test', '--watch', '--input-type='),
  ),
  perl: interpreter(opts(inline('-e='), inline('-E='), '-n', '-p', o('-i=?', { effects: ['fs:write'] }), '-l=?', '-a', '-F=?', '-M=?', '-m=?', '-I=?', '-w', '-W', '-s', '-x=?', '-0=?')),
  ruby: interpreter(opts(inline('-e='), '-n', '-p', o('-i=?', { effects: ['fs:write'] }), '-r=', '-I=', '-w', '-W=?')),
  npm: {
    options: opts(o('--prefix= -C', { role: 'cwd' }), '-w= --workspace=', '-g --global', '-s --silent', '-y --yes'),
    subcommands: {
      'run|run-script|rum|urn|test|t|tst|start|stop|restart': { effects: ['exec:project'] },
      'install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|ci|clean-install|ic|install-clean|isntall-clean|update|up|upgrade|rebuild|rb':
        { effects: ['network', 'fs:write', 'exec:project'] },
      'exec|x|init|create|innit': { effects: ['network', 'exec:arbitrary'] },
      'uninstall|unlink|remove|rm|r|un': { effects: ['fs:write'] },
      'publish|unpublish|deprecate|dist-tag|owner|access|team|login|logout|adduser': { effects: ['network'] },
      'audit|outdated|view|info|show|v|search': { effects: ['network'] },
      'ls|list|la|ll|config|get|set|pkg|prefix|root|bin|help|version|explain|why|doctor': {},
    },
  },
  npx: { posix: true, effects: ['network', 'exec:arbitrary'], options: opts('-p= --package=', o('-c= --call=', { role: 'script' }), '-y --yes', '--no') },
  make: {
    effects: ['exec:project'],
    options: opts(o('-C= --directory=', { role: 'cwd' }), o('-f= --file= --makefile=', { role: 'read' }), '-j --jobs=?', '-k --keep-going', '-n --just-print --dry-run', '-s --silent', '-B --always-make', '-e'),
  },
  rm: writer('fs:delete', '-f --force', '-i', '-I', '--interactive=?', '-r -R --recursive', '-d --dir', '-v --verbose', '--one-file-system', '--no-preserve-root', '--preserve-root=?'),
  'rmdir|unlink|shred': writer('fs:delete', '-p --parents', '-v --verbose', '-u --remove=?', '-z --zero', '-n= --iterations=', '-f --force'),
  'mkdir|touch|truncate': writer('fs:write', '-p --parents', '-m= --mode=', '-v --verbose', '-s= --size=', '-r= --reference=', '-d= --date=', '-t=', '-a', '-c --no-create'),
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
      ...'-L --location -s --silent -S --show-error -f --fail -k --insecure -I --head -i --include -v --verbose -g --globoff -N --no-buffer -G --get --compressed'.split(' ').map((name) => o(name)),
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
  'cat|less|more|wc|stat|file|nl|od|xxd|strings|md5sum|sha1sum|sha256sum|sha512sum|cmp|tac|rev|base64': reader('-n', '-c', '-l', '-w', '-b', '-s', '-v', '-A', '-E', '-T'),
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
  'uniq|cut|tr|paste|join|fold|fmt|column|expand|unexpand|diff|comm|jq|yq|tree|du|realpath|readlink|basename|dirname': reader(
    '-d= --delimiter=',
    '-f= --fields=',
    '-c --count',
    '-L= --level=',
  ),
  ls: reader('-I= --ignore=', '-w= --width=', '--color=?', '--sort=', '--time-style=', '--format=', '-a --all', '-A --almost-all', '-l', '-h --human-readable', '-R --recursive', '-1', '-t', '-r --reverse', '-S', '-d --directory', '-F --classify'),
  'echo|printf|true|false|pwd|date|whoami|id|uname|hostname|which|seq|sleep|yes|nproc|uptime|tput|clear': {},
};

/** The spec for a program by name, or `undefined` when it has none. */
export function specFor(program: string): CommandSpec | undefined {
  return specs.get(program);
}

const specs = new Map(Object.entries(programs).flatMap(([key, spec]) => key.split('|').map((name) => [name, spec] as const)));
