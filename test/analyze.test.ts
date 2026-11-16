import { describe, expect, test } from 'bun:test';
import { huskyFiles } from '#src/husky.ts';
import { allow, analyze, ask, check, checkAsync, deny, recommended, snapshot, type Arg } from '#src/index.ts';

const values = (args: Arg[]) => args.map((arg) => (arg.kind === 'static' ? arg.value : `<${arg.reason}>`));
const only = (source: string) => {
  const { invocations } = analyze(source);
  expect(invocations).toHaveLength(1);
  return invocations[0]!;
};

describe('words', () => {
  test('brace expansion: lists, nesting, sequences, and a lone brace kept', () => {
    expect(values(only('echo a{b,{c,d}}e x{1..3} {a}').argv)).toEqual(['echo', 'abe', 'ace', 'ade', 'x1', 'x2', 'x3', '{a}']);
  });

  test('field splitting splits unquoted expansions only', () => {
    expect(values(only('x="a  b"; echo $x "$x" pre$x').argv.slice(1))).toEqual(['a', 'b', 'a  b', 'prea', 'b']);
    expect(analyze('x="a  b"; echo $x').invocations[0]!.argv).toHaveLength(3);
  });

  test("a dynamic word with a known value that splits may be many words, one that doesn't can't", () => {
    const split = (source: string) => analyze(source).invocations.find((invocation) => invocation.program === 'echo')!.argv[1];
    expect(split('x="a  b"; echo "$(date)"$x')).toMatchObject({ kind: 'dynamic', split: true });
    expect(split('x=ab; echo "$(date)"$x "$x"')).toMatchObject({ kind: 'dynamic', split: false });
  });

  test('braces Bash and the parser read differently are dynamic; a } closes one only after a comma', () => {
    expect(values(only('echo {a}s,d}e x{a,[}b}y {a,b}}').argv)).toEqual(['echo', '<variable>', 'xab}y', 'x[b}y', 'a}', 'b}']);
  });

  test("braces expand before variables: a name runs into a brace's alternatives", () => {
    const source = 'x=X; xa=A; xb=B; xac=AC; x1=ONE; echo $x{a,b} {p,q}$x{a,b} {$x{a,b},c}c $x{1..1} $x{a}';
    expect(values(only(source).argv)).toEqual(['echo', 'A', 'B', 'pA', 'pB', 'qA', 'qB', 'AC', '<variable>', 'cc', 'ONE', 'X{a}']);
  });

  test("a $ that starts no expansion keeps the word from splitting, a quoted or escaped one doesn't", () => {
    expect(values(only('x="a  b"; echo $x-$ $x"$" $x\\$').argv)).toEqual(['echo', 'a  b-$', 'a', 'b$', 'a', 'b$']);
    // Unless an unquoted expansion comes after it.
    expect(values(only('x="a  b"; echo $x$/"$x" $x$/$x').argv)).toEqual(['echo', 'a  b$/a  b', 'a', 'b$/a', 'b']);
  });

  test('an unquoted known value with a pattern is a glob; an assignment removes the quotes in one', () => {
    expect(values(only(`x='*'; y=a['q']"b"; echo $x "$x" "$y"`).argv)).toEqual(['echo', '<glob>', '*', 'a[q]b']);
  });

  test('an unquoted empty expansion is no word, a quoted one is an empty word', () => {
    expect(values(only('e=; echo $e "$e" end').argv)).toEqual(['echo', '', 'end']);
  });

  test('globs, positionals and substitutions are dynamic', () => {
    const [date, echo] = analyze('echo *.ts "$1" $(date)').invocations;
    expect(date!.program).toBe('date');
    expect(values(echo!.argv)).toEqual(['echo', '<glob>', '<positional>', '<substitution>']);
  });
});

describe('options', () => {
  test('values attached, separate, after = and in clusters', () => {
    const { options } = only('tail -n5 --bytes 10 -fn 3 file');
    expect(options['--lines']).toEqual([
      { kind: 'static', value: '5' },
      { kind: 'static', value: '3' },
    ]);
    expect(options['--bytes']).toEqual([{ kind: 'static', value: '10' }]);
    expect(options['--follow']).toEqual([true]);
  });

  test('an ambiguous abbreviation stays unknown, as git rejects it', () => {
    const invocation = only('git push --forc origin');
    expect(invocation.unknownOptions).toEqual(['--forc']);
    expect(invocation.options['--force']).toBeUndefined();
  });

  test('POSIX programs stop reading options at the first positional', () => {
    const [sudo, rm] = analyze('sudo -u root rm -rf x').invocations;
    expect(Object.keys(sudo!.options)).toEqual(['--user']);
    expect(Object.keys(rm!.options).sort()).toEqual(['--force', '--recursive']);
    expect(rm!.via).toEqual(['sudo']);
  });

  test('a program without a spec gets its clusters split', () => {
    const invocation = only('cowsay -ab --cd=1 hi');
    expect(invocation.specified).toBe(false);
    expect(invocation.unknownOptions).toEqual(['-a', '-b', '--cd']);
  });

  test('gh finds its subcommand as cobra does: a flag before it takes the next word unless it is a known boolean', () => {
    for (const source of ['gh -R o/r pr merge 1', 'gh pr -R o/r merge 1', 'gh pr merge --repo=o/r 1']) {
      const invocation = only(source);
      expect(invocation.subcommands).toEqual(['pr', 'merge']);
      expect(values(invocation.options['--repo'] as Arg[])).toEqual(['o/r']);
      expect(values(invocation.positionals)).toEqual(['1']);
    }
    expect(only('gh pr ls').subcommands).toEqual(['pr', 'list']);
    // `--foo` takes `pr`, so `merge` is the command: an alias or an extension, if anything.
    const unknown = only('gh --foo pr merge');
    expect(unknown.subcommands).toEqual([]);
    expect(unknown.unknownSubcommand).toEqual({ kind: 'static', value: 'merge' });
    expect(unknown.effects).toContain('exec:arbitrary');
  });

  test('each subcommand is named as itself, and an alias as its subcommand', () => {
    for (const [source, subcommands] of [
      ['git revert HEAD', ['revert']],
      ['git annotate f', ['annotate']],
      ['git stash clear', ['stash', 'clear']],
      ['git stash save x', ['stash', 'save']],
      ['git remote rm o', ['remote', 'remove']],
      ['npm unpublish x', ['unpublish']],
      ['npm clean-install', ['ci']],
      ['npm tst', ['test']],
      ['npm add x', ['install']],
    ] satisfies [string, string[]][])
      expect([source, only(source).subcommands]).toEqual([source, subcommands]);
  });

  test('gh reads files given to it, writes where it downloads, and runs git clone with the flags after --', () => {
    expect(values(only('gh api repos/o/r -F a=@notes.md -F b=c -F c=@-').reads)).toEqual(['notes.md']);
    expect(values(only('gh release create v1 a.zip b.zip --notes-file notes.md').reads)).toEqual(['notes.md', 'a.zip', 'b.zip']);
    expect(values(only('gh release download v1 -D out').writes)).toEqual(['out']);
    const copy = only('gh codespace cp remote:a b.txt');
    expect(values(copy.writes)).toEqual(['b.txt']);
    expect(values(only('gh codespace cp a.txt remote:b').reads)).toEqual(['a.txt']);
    expect(only('gh codespace cp -- -S prog remote:a b').effects).toContain('exec:arbitrary');
    const [, git] = analyze('gh repo clone o/r dir -- --depth 1').invocations;
    expect(values(git!.argv)).toEqual(['git', 'clone', 'dir', '--depth', '1', 'o/r']);
    expect(git!.via).toEqual(['gh']);
  });

  test("sed -i's backup and cp --parents write where the path leads", () => {
    expect(values(only("sed -i'/home/me/.bash*' s/x/y/ rc").writes)).toEqual(['rc', '/home/me/.bashrc']);
    expect(values(only("sed --in-place='../bak_*' s/x/y/ rc").writes)).toEqual(['rc', '../bak_rc']);
    expect(values(only('sed -i.orig s/x/y/ sub/rc').writes)).toEqual(['sub/rc', 'sub/rc.orig']);
    expect(only("sed -i'b_*' s/x/y/ sub/rc").writes[1]?.kind).toBe('dynamic');
    expect(values(only('cp --parents ../../s/f d').writes)).toEqual(['d', 'd/../../s/f']);
  });

  test('SHELL is sensitive, and unshare or chroot with no command runs a shell no one sees', () => {
    expect(analyze('SHELL=x/bash flock lk -c "echo hi"').findings.map((finding) => finding.kind)).toContain('sensitive-variable');
    expect(only('unshare -r').effects).toContain('exec:arbitrary');
    expect(only('chroot /').effects).toContain('exec:arbitrary');
    expect(analyze('unshare -r true').invocations[0]!.effects).not.toContain('exec:arbitrary');
  });

  test('output-file positionals are writes, not reads', () => {
    for (const source of ['uniq input output', 'xxd -r input output']) {
      const invocation = only(source);
      expect(values(invocation.reads)).toEqual(['input']);
      expect(values(invocation.writes)).toEqual(['output']);
    }

    const vim = only('vim -S startup.vim');
    expect(values(vim.reads)).toEqual(['startup.vim']);
    expect(vim.effects).toContain('exec:file');
  });
});

describe('invocations', () => {
  test('a blank-ending alias reaches past quoted words, but not past an unquoted expansion', () => {
    const argv = (source: string) =>
      values(analyze(`shopt -s expand_aliases\nalias s='cat ' q=sort\n${source}`).invocations.find((i) => i.program === 'cat')!.argv);
    expect(argv("s \\a 'b' q")).toEqual(['cat', 'a', 'b', 'sort']);
    expect(argv('s \\a <(:) q')).toEqual(['cat', 'a', '<substitution>', 'q']);
    expect(argv('s $x q')).toEqual(['cat', '<variable>', 'q']);
  });

  test('shape leaves values out', () => {
    expect(only('git -C repo commit -m "fix it" --amend').shape).toBe('git commit --amend --message=<v> -C=<v>');
  });

  test('code from a string reports the span of the command holding it', () => {
    const source = 'echo ok; bash -c "rm -rf /"';
    const rm = analyze(source).invocations.find((invocation) => invocation.program === 'rm')!;
    expect(source.slice(...rm.span)).toBe('bash -c "rm -rf /"');
    expect(rm.nesting).toEqual(['bash -c']);
  });

  test('a child shell sees exported variables only', () => {
    const echo = analyze('a=1; export b=2; bash -c \'echo "$a" "$b"\'').invocations.find((invocation) => invocation.program === 'echo')!;
    expect(values(echo.argv)).toEqual(['echo', '<variable>', '2']);
  });

  test('a recursive function emits a finding instead of silently stopping', () => {
    const analysis = analyze('f() { f; }; f');
    expect(analysis.findings.map((finding) => finding.kind)).toContain('too-deep');
  });

  test('a pipeline runs in subshells: assignments in it do not last', () => {
    const echo = analyze('x=1; echo | x=2; echo $x').invocations.at(-1)!;
    expect(values(echo.argv)).toEqual(['echo', '1']);
  });

  test('cd is tracked for where commands run', () => {
    const cwd = (source: string) => analyze(source).invocations.at(-1)!.cwd;
    expect(cwd('cd /srv && cd app && ls')).toBe('/srv/app');
    expect(cwd('cd /srv && ls')).toBe('/srv');
    // A cd fails on a directory that isn't there, and the shell stays: after `;`, either may hold.
    expect(cwd('cd /srv; ls')).toBeUndefined();
    expect(cwd('cd /srv && cd app; ls')).toBeUndefined();
    expect(cwd('cd /srv || ls')).toBe('.');
    expect(cwd('! cd /srv && ls')).toBe('.');
    expect(cwd('cd /srv || cd /opt && ls')).toBeUndefined();
    expect(cwd('if cd /srv; then ls; fi')).toBe('/srv');
    expect(cwd('if cd /srv; then :; else ls; fi')).toBe('.');
    expect(cwd('cd "$d" && ls')).toBeUndefined();
  });

  test('a loop is walked until it settles, so a value three iterations away is seen', () => {
    const analysis = analyze('x=ls; y=ls; z=ls; for i in 1 2 3; do $z /; z=$y; y=$x; x=rm; done');
    expect(analysis.invocations.some((invocation) => invocation.program === null)).toBe(true);
  });

  test('deeply nested loops cost little more than shallow ones', () => {
    const plain = 'for a in 1 2; do '.repeat(40) + 'ls $a; ' + 'done; '.repeat(40);
    const reassigning =
      Array.from({ length: 40 }, (_, i) => `y${i}=ls; for a in 1; do $y${i}; y${i}=rm; cd d${i}; `).join('') + 'done; '.repeat(40);
    for (const source of [plain, reassigning]) {
      const start = performance.now();
      const analysis = analyze(source);
      expect(performance.now() - start).toBeLessThan(1000);
      expect(analysis.findings.map((finding) => finding.kind)).not.toContain('too-deep');
    }
  });

  test('xargs appends arguments, so its command may have any option', () => {
    const rm = analyze('xargs rm').invocations[1]!;
    expect(rm.open).toBe(true);
    expect(rm.maybeOptions).toBe(true);
  });

  test('find -exec replaces {} with a placeholder', () => {
    const rm = analyze("find . -exec rm {} ';'").invocations[1]!;
    expect(values(rm.argv)).toEqual(['rm', '<placeholder>']);
  });

  test('reads Git config includes, hooks and package lifecycle scripts from the filesystem', () => {
    const files: Record<string, string> = {
      '/repo/.git': 'gitdir: .git/worktrees/app',
      '/repo/.git/worktrees/app/commondir': '../..',
      '/repo/.git/config': '[include]\n path = extra.conf\n[core]\n hooksPath = /repo/custom-hooks',
      '/repo/.git/extra.conf': '[core]\n pager = cat configured\n',
      '/repo/custom-hooks/pre-commit': 'cat hook',
      '/repo/package.json': JSON.stringify({ scripts: { pretest: 'cat before', test: 'cat run', posttest: 'cat after' } }),
      '/repo/ssh.conf': 'Match exec "cat match"\n',
    };
    const fs = { readFile: (path: string) => files[path] ?? null, realpath: (path: string) => path };
    const git = analyze('git commit -m x', { cwd: '/repo', fs });
    expect(git.invocations.filter((invocation) => invocation.program === 'cat').map((invocation) => values(invocation.argv))).toEqual([
      ['cat', 'configured'],
      ['cat', 'hook'],
    ]);
    expect(git.findings.some((finding) => finding.kind === 'exec-config')).toBe(true);

    const npm = analyze('npm test', { cwd: '/repo', fs });
    expect(npm.invocations.filter((invocation) => invocation.program === 'cat').map((invocation) => values(invocation.argv))).toEqual([
      ['cat', 'before'],
      ['cat', 'run'],
      ['cat', 'after'],
    ]);

    const ssh = analyze('ssh -F ssh.conf host', { cwd: '/repo', fs });
    expect(ssh.invocations.some((invocation) => invocation.program === 'cat' && values(invocation.argv).includes('match'))).toBe(true);
  });

  test('git config is read from whichever directory git takes as the repository', () => {
    const head = 'ref: refs/heads/main\n';
    const evil = '[core]\n\tfsmonitor = cat ran\n';
    const repository = (dir: string, config?: string) => ({
      files: { [`${dir}/HEAD`]: head, ...(config === undefined ? {} : { [`${dir}/config`]: config }) },
      dirs: [`${dir}/objects`, `${dir}/refs`],
    });
    const runs = (source: string, cwd: string, ...parts: { files: Record<string, string>; dirs?: string[] }[]) => {
      const files: Record<string, string> = Object.assign({}, ...parts.map((part) => part.files));
      const dirs = new Set(parts.flatMap((part) => part.dirs ?? []));
      const fs = {
        readFile: (path: string) => files[path] ?? null,
        realpath: (path: string) => (path in files || dirs.has(path) ? path : null),
      };
      const analysis = analyze(source, { cwd, fs });
      return analysis.invocations.some((invocation) => invocation.program === 'cat' && values(invocation.argv).includes('ran'));
    };
    const outer = repository('/repo/.git', evil);
    const made = repository('/repo/made', evil);
    const decoy = { files: { '/repo/made/.git/config': '' } };

    // A directory made to look like a repository, with no `.git` in its path.
    expect(runs('git fetch o', '/repo/made', repository('/repo/.git', ''), made)).toBe(true);
    expect(runs('git fetch o', '/repo/made/objects', repository('/repo/.git', ''), made)).toBe(true);
    expect(runs('git --git-dir=made status', '/repo', repository('/repo/.git', ''), made)).toBe(true);
    expect(runs('git --git-dir made --work-tree . status', '/repo', repository('/repo/.git', ''), made)).toBe(true);
    expect(runs('git --bare log', '/repo/made', repository('/repo/made/.git', ''), made)).toBe(true);
    expect(runs('git -C made fetch o', '/repo', repository('/repo/.git', ''), made)).toBe(true);
    // A `.git` git doesn't take (no HEAD, objects or refs) hides neither the directory it's in nor the ones above.
    expect(runs('git status', '/repo/made', decoy, made)).toBe(true);
    expect(runs('git status', '/repo/sub', { files: { '/repo/sub/.git/config': '' } }, outer)).toBe(true);
    expect(runs('git status', '/repo/sub', { files: { '/repo/sub/.git/HEAD': head } }, outer)).toBe(true);
    expect(runs('git status', '/repo/sub', { files: { '/repo/sub/HEAD': head } }, outer)).toBe(true);
    // One git does take ends the search, with or without a config.
    expect(runs('git status', '/repo/sub', repository('/repo/sub/.git'), outer)).toBe(false);
    expect(runs('git status', '/repo/sub', repository('/repo/sub'), outer)).toBe(false);
    expect(runs('git --git-dir=sub/.git status', '/repo', repository('/repo/sub/.git'), outer)).toBe(false);

    const dynamic = analyze('git --git-dir "$d" status', { cwd: '/repo', fs: { readFile: () => null, realpath: () => null } });
    expect(dynamic.findings.some((finding) => finding.kind === 'exec-config')).toBe(true);
  });

  test('the hooks of core.hooksPath are followed where git is certain to look for them', () => {
    const repository = (config: string, more: Record<string, string> = {}): Record<string, string> => ({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.git/config': config,
      '/repo/hooks/pre-commit': 'cat ran',
      '/repo/hooks/post-index-change': 'cat ran',
      '/home/me/hooks/pre-commit': 'cat ran',
      ...more,
    });
    const result = (source: string, files: Record<string, string>, cwd = '/repo', env: Record<string, string> = {}) => {
      const fs = { readFile: (path: string) => files[path] ?? null, realpath: (path: string) => path };
      const analysis = analyze(source, { cwd, fs, env });
      const ran = analysis.invocations.some((invocation) => invocation.program === 'cat' && values(invocation.argv).includes('ran'));
      return { ran, asked: analysis.findings.some((finding) => finding.kind === 'exec-config') };
    };
    const followed = { ran: true, asked: false };
    const relative = repository('[core]\n\thooksPath = hooks\n');
    expect(result('git commit -m x', relative)).toEqual(followed);
    expect(result('git commit -m x', relative, '/repo/src')).toEqual(followed);
    expect(result('git status', relative)).toEqual(followed);
    expect(result('git --version', relative)).toEqual({ ran: false, asked: false });
    expect(result('git --git-dir=.git commit -m x', repository('[core]\n\thooksPath = /repo/hooks\n'))).toEqual(followed);
    const home = repository('[core]\n\thooksPath = ~/hooks\n');
    expect(result('git commit -m x', home, '/repo', { HOME: '/home/me' })).toEqual(followed);

    // Where git looks isn't certain: a relative path is read from where the hook runs, `~` and `%(prefix)` by git.
    expect(result('git commit -m x', home).asked).toBe(true);
    expect(result('git --git-dir=.git commit -m x', relative).asked).toBe(true);
    expect(result('git --work-tree=/repo commit -m x', relative).asked).toBe(true);
    expect(result('git commit -m x', repository('[core]\n\thooksPath = %(prefix)/hooks\n')).asked).toBe(true);
    expect(result('git commit -m x', repository('[core]\n\thooksPath = ~other/hooks\n'), '/repo', { HOME: '/home/me' }).asked).toBe(true);
    // An include git may not take, and the file `extensions.worktreeConfig` adds.
    const included = { '/repo/.git/more.conf': '[core]\n\thooksPath = /elsewhere\n' };
    expect(result('git commit -m x', repository('[includeIf "gitdir:/x/"]\n\tpath = more.conf\n', included)).asked).toBe(true);
    expect(result('git commit -m x', repository('', { '/repo/.git/config.worktree': '[core]\n\thooksPath = /elsewhere\n' })).asked).toBe(
      true,
    );
    expect(result('git status', repository('', { '/repo/.git/config.worktree': '[core]\n\tfsmonitor = cat ran\n' })).ran).toBe(true);
    // A hook the config defines is code as well.
    const defined = repository('[hook "x"]\n\tcommand = cat ran\n\tevent = reference-transaction\n');
    expect(result('git branch b', defined)).toEqual({ ran: true, asked: true });
  });

  test('each git command runs its own hooks, and any of them the ones for an index or a ref write', () => {
    const names =
      'post-index-change reference-transaction pre-commit commit-msg post-commit post-checkout post-merge pre-rebase pre-push pre-auto-gc sendemail-validate';
    const files: Record<string, string> = { '/repo/.git/HEAD': 'ref: refs/heads/main\n' };
    for (const name of names.split(' ')) files[`/repo/.git/hooks/${name}`] = `cat ${name}`;
    const fs = { readFile: (path: string) => files[path] ?? null, realpath: (path: string) => path };
    const hooks = (source: string) =>
      analyze(source, { cwd: '/repo', fs })
        .invocations.filter((invocation) => invocation.program === 'cat')
        .map((invocation) => values(invocation.argv)[1])
        .join(' ');
    const writes = 'post-index-change reference-transaction';
    expect(hooks('git --version')).toBe('');
    for (const source of ['git status', 'git log', 'git add .', 'git branch b', 'git stash', 'git remote add o url', 'git reset HEAD~1'])
      expect([source, hooks(source)]).toEqual([source, writes]);
    for (const source of ['git checkout main', 'git switch main', 'git restore f', 'git stash branch b'])
      expect([source, hooks(source)]).toEqual([source, `${writes} post-checkout`]);
    for (const source of ['git fetch', 'git remote update', 'git gc'])
      expect([source, hooks(source)]).toEqual([source, `${writes} pre-auto-gc`]);
    expect(hooks('git push')).toBe(`${writes} pre-push`);
    expect(hooks('git commit -m x')).toBe(`${writes} pre-commit commit-msg post-commit pre-auto-gc`);
    expect(hooks('git commit --no-verify -m x')).toBe(`${writes} post-commit pre-auto-gc`);
    expect(hooks('git pull')).toBe(`${writes} pre-rebase post-checkout post-merge pre-auto-gc pre-commit commit-msg post-commit`);
    // A command the table doesn't have, an alias or one only known at run time may run any hook.
    for (const source of ['git frobnicate', 'git worktree add ../w', 'git "$x"', 'git stash "$x"'])
      expect([source, hooks(source).split(' ').toSorted()]).toEqual([source, names.split(' ').toSorted()]);
  });

  test('npm runs the scripts of its verb under any alias, and restart may run stop and start', () => {
    const scripts = { pretest: 'cat before', test: 'cat test', stop: 'cat stop', start: 'cat start' };
    const fs = {
      readFile: (path: string) => (path === '/repo/package.json' ? JSON.stringify({ scripts }) : null),
      realpath: (path: string) => path,
    };
    const cats = (source: string) =>
      analyze(source, { cwd: '/repo', fs })
        .invocations.filter((invocation) => invocation.program === 'cat')
        .map((invocation) => values(invocation.argv)[1]);
    for (const source of ['npm test', 'npm tst', 'npm run test', 'npm rum test', 'npm run-script test'])
      expect([source, cats(source)]).toEqual([source, ['before', 'test']]);
    expect(cats('npm restart')).toEqual(['stop', 'start']);
  });

  test('pnpm and bun run a script by its name, a file or a command from PATH when no script has it', () => {
    const scripts = { prelint: 'cat before', lint: 'cat lint', postlint: 'cat after', check: 'cat check' };
    const fs = snapshot({
      files: { '/repo/package.json': JSON.stringify({ scripts }), '/bare/package.json': '{}' },
      realpaths: { '/repo': '/repo', '/bare': '/bare' },
    });
    const run = (source: string) => {
      const analysis = analyze(source, { cwd: '/repo', fs });
      return [
        analysis.invocations.slice(1).map((invocation) => values(invocation.argv).join(' ')),
        analysis.invocations[0]!.effects.toSorted(),
      ];
    };
    // bun installs what the code it runs imports, with no node_modules.
    for (const source of ['pnpm lint', 'pnpm run lint', 'bun lint', 'bun run lint']) {
      const effects = source.startsWith('bun') ? ['exec:project', 'network:read'] : ['exec:project'];
      expect([source, run(source)]).toEqual([source, [['cat before', 'cat lint', 'cat after'], effects]]);
    }
    expect(run('bun check')).toEqual([['cat check'], ['exec:project']]);
    expect(run('pnpm node -e 1')).toEqual([['node -e 1'], ['exec:project']]);
    expect(run('bun run node -e 1')).toEqual([['node -e 1'], ['exec:file', 'exec:project', 'network:read']]);
    expect(run('bun f')).toEqual([[], ['exec:file', 'exec:project', 'network:read']]);
    expect(run('bun fmt')).toEqual([[], ['exec:project', 'fs:write']]);
    expect(run('bun --cwd /bare lint')).toEqual([[], ['exec:file', 'exec:project', 'network:read']]);
    // Another package's scripts, and those bun runs in its own shell, aren't followed.
    for (const source of ['pnpm -r lint', 'pnpm --filter a lint', 'bun --filter a lint', 'bun --shell=bun lint', 'npm -w a run lint'])
      expect([source, run(source)[0]!.filter((words) => words.startsWith('cat'))]).toEqual([source, []]);
    expect(run('pnpm test --silent')).toEqual([[], ['exec:project']]);
  });

  test('the words after a script are walked with it, and npm pack and version run theirs', () => {
    const scripts = { test: 'cat', cfg: 'git config', prepack: 'cat pack', version: 'cat version', x: 'cat x' };
    const fs = {
      readFile: (path: string) =>
        path === '/repo/package.json'
          ? JSON.stringify({ scripts })
          : path === '/repo/run/package.json'
            ? JSON.stringify({ scripts: { test: 'cat other' } })
            : null,
      realpath: (path: string) => path,
    };
    const environment = { cwd: '/repo', fs };
    const ran = (source: string) =>
      analyze(source, environment)
        .invocations.slice(1)
        .map((invocation) => values(invocation.argv).join(' '));
    for (const source of ["npm test -- a 'b c'", "pnpm test a 'b c'", "pnpm run test a 'b c'", "bun run test a 'b c'"])
      expect([source, ran(source)]).toEqual([source, ['cat a b c']]);
    expect(ran('npm test -- "it\'s"')).toEqual(["cat it's"]);
    expect(check('npm run cfg -- core.hooksPath /tmp/x', recommended, environment).decision).toBe('ask');
    expect(check('npm test -- "$x"', recommended, environment).decision).toBe('ask');
    // npm's -C takes a directory: `run` here.
    expect(ran('npm -C run test')).toEqual(['cat other']);
    expect(ran('npm -g run x')).toEqual(['cat x']);
    expect(ran('npm pack')).toEqual(['cat pack']);
    // and commits and tags with git, whose hooks run.
    expect(ran('npm version patch')).toEqual([
      'cat version',
      'git add -- package.json',
      'git commit -m version',
      'git tag -m version version',
    ]);
    expect(ran('npm pack --ignore-scripts')).toEqual([]);
    // Only as a flag: npm reads a value it's given.
    expect(ran('npm --ignore-scripts=false pack')).toEqual(['cat pack']);
    // bun drops the `--` right after the name; pnpm passes it on.
    expect(ran('bun run test -- a')).toEqual(['cat a']);
    expect(ran('bun test -- a')).toEqual([]);
    expect(ran('bun run test a -- b')).toEqual(['cat a -- b']);
    expect(ran('pnpm test -- a')).toEqual(['cat -- a']);
    // Without a package.json here, npm looks for one above.
    expect(check('npm test', recommended, { cwd: '/bare', fs }).decision).toBe('ask');
  });

  test('project code is where the script starts, really: a symlink under it may lead out', () => {
    const fs = snapshot({
      files: { '/repo/package.json': '{}', '/tmp/x/package.json': '{}' },
      realpaths: { '/repo': '/repo', '/repo/sub': '/repo/sub', '/repo/link': '/tmp/x', '/tmp/x': '/tmp/x' },
    });
    const effects = (source: string) => analyze(source, { cwd: '/repo', fs }).invocations.at(-1)!.effects;
    expect(effects('cd sub && cargo build --offline')).toEqual(['exec:project']);
    for (const source of [
      'cd link && cargo build --offline',
      'bun test ./link/a.test.ts',
      'eslint link',
      'cp -s /tmp/x/a l && cd l && cargo build',
    ])
      expect([source, effects(source)]).toContainEqual(expect.arrayContaining(['exec:file']));
  });

  test('git opens core.hooksPath and include paths as given: a .. after a symlink leads up from its target', () => {
    const files: Record<string, string> = {
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.git/config': '[core]\n\thooksPath = x/../hooks\n',
      '/repo/hooks/pre-commit': 'cat ok',
      '/other/hooks/pre-commit': 'rm -rf /',
      '/other/evil.cfg': '[core]\n\thooksPath = /other/hooks\n',
    };
    const fs = {
      readFile: (path: string) => files[path] ?? null,
      realpath: (path: string) => (path === '/repo/x' || path.startsWith('/repo/x/') ? `/other/sub${path.slice(7)}` : path),
    };
    const environment = { cwd: '/repo', fs };
    expect(check('git commit -m x', recommended, environment).decision).toBe('deny');
    files['/repo/.git/config'] = '[include]\n\tpath = ../x/../evil.cfg\n';
    expect(check('git commit -m x', recommended, environment).decision).toBe('deny');
    files['/repo/.git/config'] = '[core]\n\thooksPath = hooks\n';
    expect(check('git commit -m x', recommended, environment).decision).toBe('allow');
  });

  test("a package.json the script writes first isn't the one its scripts are read from", () => {
    const fs = snapshot({
      files: { '/repo/package.json': JSON.stringify({ scripts: { test: 'cat ok' } }) },
      realpaths: { '/repo': '/repo', '/repo/package.json': '/repo/package.json' },
    });
    const environment = { cwd: '/repo', fs };
    expect(check('npm test', recommended, environment).decision).toBe('allow');
    for (const source of ['npm pkg set scripts.test="rm -rf /" && npm test', 'echo {} > package.json && pnpm test'])
      expect([source, analyze(source, environment).findings.map((finding) => finding.kind)]).toEqual([source, ['unknown-file']]);
  });

  test('a command of a pipeline reads what the others may write, but not what it writes itself afterwards', () => {
    const fs = snapshot({
      files: { '/repo/package.json': JSON.stringify({ scripts: { test: 'cat ok; ./build.sh' } }) },
      realpaths: { '/repo': '/repo', '/repo/package.json': '/repo/package.json' },
    });
    const findings = (source: string) => analyze(source, { cwd: '/repo', fs }).findings.map((finding) => finding.kind);
    expect(findings('npm test | cat')).toEqual([]);
    expect(findings('npm test | (cat; ./build.sh)')).toEqual(['unknown-file']);
    expect(findings('./build.sh | npm test')).toEqual(['unknown-file']);
    // Run in the background, it may still be running when the script writes after it.
    expect(findings('npm test | cat & ./build.sh')).toEqual(['unknown-file']);
    expect(findings('npm test | cat; ./build.sh')).toEqual([]);
  });

  test("husky's hooks are the project's own in .husky, for every version of what husky writes", () => {
    const { stub91, stub90, dispatcher91, dispatcher90, helper8, helper7, deprecated91 } = huskyFiles;
    const repo = (hooksPath: string, husky: Record<string, string>) => {
      const files: Record<string, string> = {
        '/repo/.git/HEAD': 'ref: refs/heads/main\n',
        '/repo/.git/config': `[core]\n\thooksPath = ${hooksPath}\n`,
        ...Object.fromEntries(Object.entries(husky).map(([path, text]) => [`/repo/.husky/${path}`, text])),
      };
      const fs = { readFile: (path: string) => files[path] ?? null, realpath: (path: string) => path };
      return (source: string) => check(source, recommended, { cwd: '/repo', fs });
    };
    const own = (lines: string) => `#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\n\n${lines}\n`;
    const versions = {
      '9.1': repo('.husky/_', { '_/pre-commit': stub91, '_/h': dispatcher91, '_/husky.sh': deprecated91 }),
      '9.0': repo('.husky/_', { '_/pre-commit': stub90, '_/h': dispatcher90, '_/husky.sh': '' }),
      '8': repo('.husky', { '_/husky.sh': helper8 }),
      '7': repo('.husky', { '_/husky.sh': helper7 }),
    };
    // With no hook of the project's own, husky runs nothing.
    for (const [version, files] of Object.entries(versions))
      expect([version, files('git commit -m x').decision]).toEqual([version, 'allow']);
    // The project's hook is what's judged, with husky's old helper line left out.
    const hooked = (hook: string) =>
      repo('.husky/_', { '_/pre-commit': stub91, '_/h': dispatcher91, '_/husky.sh': deprecated91, 'pre-commit': own(hook) });
    expect(hooked('cat lint')('git commit -m x').decision).toBe('allow');
    expect(hooked('rm -rf /')('git commit -m x').decision).toBe('deny');
    expect(hooked('rm -rf /')('git commit --no-verify -m x').decision).toBe('allow');
    const legacy = repo('.husky', { '_/husky.sh': helper8, 'pre-commit': own('rm -rf /') });
    expect(legacy('git commit -m x').decision).toBe('deny');
    // A file husky didn't write as it is, or one the script may change first, is walked as it is, which asks.
    for (const changed of [
      repo('.husky/_', { '_/pre-commit': stub91, '_/h': `${dispatcher91}\necho`, 'pre-commit': 'cat lint' }),
      repo('.husky/_', { '_/pre-commit': `${stub91}\nls`, '_/h': dispatcher91, 'pre-commit': 'cat lint' }),
      repo('.husky', { '_/husky.sh': `${helper8}\necho`, 'pre-commit': own('cat lint') }),
    ])
      expect(changed('git commit -m x').decision).toBe('ask');
    expect(hooked('cat lint')('echo x > .husky/_/h && git commit -m x').decision).toBe('ask');
  });

  test('tsc and biome write only files of their kinds, where project code may write anything', () => {
    const files: Record<string, string> = {
      '/repo/package.json': JSON.stringify({ scripts: { test: 'cat ok' } }),
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.git/config': '[include]\n\tpath = /repo/settings.js\n',
      '/repo/settings.js': '',
    };
    const fs = { readFile: (path: string) => files[path] ?? null, realpath: (path: string) => path };
    const findings = (source: string) => analyze(source, { cwd: '/repo', fs }).findings.map((finding) => finding.message);
    for (const source of ['biome check --write && npm test', 'biome format --write . && npm test'])
      expect([source, findings(source)]).toEqual([source, []]);
    // tsc copies the JSON its sources import into its output, from wherever they are; but --noEmit writes nothing.
    for (const source of ['tsc && npm test', 'tsgo -b && npm test', 'tsc --outDir . -p . && npm test'])
      expect([source, findings(source)]).toEqual([source, ["`/repo/package.json` may be changed by the script before it's read"]]);
    expect(findings('tsc --noEmit && npm test')).toEqual([]);
    // A file it's given to write is written whatever its name.
    for (const source of [
      'tsc --outFile package.json && npm test',
      'tsc --tsBuildInfoFile package.json && npm test',
      'tsc --OUTFILE package.json && npm test',
    ])
      expect([source, findings(source)]).toEqual([source, ["`/repo/package.json` may be changed by the script before it's read"]]);
    for (const source of ['oxlint --fix && npm test', 'prettier --write . && npm test', 'vitest run && npm test'])
      expect([source, findings(source)]).toEqual([source, ["`/repo/package.json` may be changed by project code before it's read"]]);
    // A file of a kind tsc emits is unknown after it, wherever it is: git config may include one.
    expect(findings('git status')).toEqual([]);
    expect(findings('tsc && git status')).toEqual(["`/repo/settings.js` may be changed by the script before it's read"]);
  });
});

describe('arithmetic', () => {
  const dynamicContexts = [
    'x="$v"; (( x ))',
    'x="$v"; (( x++ ))',
    'x="$v"; (( x += 1 ))',
    'x="$v"; echo $((x))',
    'x="$v"; for ((i=x; i<1; i++)); do :; done',
    'x="$v"; let x',
    'x="$v"; [[ x -eq 1 ]]',
    'x="$v"; a[x]=1',
    'x="$v"; echo ${s:x}',
    'x="$v"; declare -i n=x',
  ];

  for (const source of dynamicContexts) {
    test(`asks about a non-numeric dynamic value in ${source}`, () => {
      expect(analyze(source).findings.some((finding) => finding.kind === 'dynamic-arithmetic')).toBe(true);
    });
  }

  test('follows static values recursively and keeps arithmetic results numeric', () => {
    for (const source of ['x=1+2; ((x))', 'x=foo; foo=1+2; ((x))', 'n=$((1+2)); ((n))', 'i=0; while ((i<2)); do ((i++)); done'])
      expect(analyze(source).findings.some((finding) => finding.kind === 'dynamic-arithmetic')).toBe(false);
  });

  test('a name hashed in only one branch, to a path only known at run time, may be anything', () => {
    const source = 'if a; then :; else hash -p /bin/cat h; for i in 1; do hash -p /bin/rm h; done; fi; h';
    expect(analyze(source).findings.some((finding) => finding.kind === 'loads-code')).toBe(true);
  });
});

describe('policy', () => {
  test('a deny rule that may match asks, or denies when strict', () => {
    const rules = [deny('rm', { options: ['-r'] })];
    expect(check('rm $x file', { rules, default: 'allow' }).decision).toBe('ask');
    expect(check('rm $x file', { rules, default: 'allow', strict: true }).decision).toBe('deny');
    expect(check('rm file', { rules, default: 'allow' }).decision).toBe('allow');
  });

  test('rule options use the spec spelling at the subcommand', () => {
    expect(check('git branch -D x', { rules: [deny('git branch', { options: ['-d'] })], default: 'allow' }).decision).toBe('deny');
  });

  test('a subcommand only known at run time may be any, at every level under it', () => {
    expect(check('git $x stash drop', { rules: [deny('git stash drop')], default: 'allow' }).decision).toBe('ask');
    expect(check('gh $x pr merge', { rules: [deny('gh pr merge')], default: 'allow' }).decision).toBe('ask');
  });

  test('a rule names one subcommand, not the others read alike', () => {
    const policy = { rules: [deny('git revert'), deny('npm unpublish')], default: 'allow' as const };
    expect(check('git revert HEAD', policy).decision).toBe('deny');
    expect(check('npm unpublish x', policy).decision).toBe('deny');
    expect(check('git cherry-pick x', policy).decision).toBe('allow');
    expect(check('npm publish', policy).decision).toBe('allow');
  });

  test('gh rules match wherever the flags are, as gh reads them', () => {
    const policy = { rules: [deny('gh pr merge', { options: ['--admin'] })], default: 'allow' as const };
    for (const source of [
      'gh pr merge 1 --admin',
      'gh -R o/r pr merge --admin',
      'gh pr -R o/r merge --admin',
      'gh --repo o/r pr --json x merge --admin',
    ])
      expect(check(source, policy).decision).toBe('deny');
    expect(check('gh pr merge 1', policy).decision).toBe('allow');
    // `pr` has no `--admin`, so it takes `merge` as its value: gh prints usage and merges nothing.
    expect(check('gh pr --admin merge', policy).decision).toBe('allow');
    expect(check('GH_PAGER=x gh pr view', { rules: [allow('gh pr view')], default: 'deny' }).decision).toBe('ask');
  });

  test('~ is $HOME when it is known, so ~ globs match absolute paths and the other way round', () => {
    const env = { HOME: '/home/me' };
    expect(check('rm -rf /home/me', recommended, { env }).decision).toBe('deny');
    expect(check('rm -rf ~/', recommended, { env }).decision).toBe('deny');
    expect(check('cd && rm -rf .', recommended, { env }).decision).toBe('deny');
    expect(check('echo hi > ~/.bashrc', { rules: [deny({ writes: ['/home/me/**'] })], default: 'allow' }, { env }).decision).toBe('deny');
    expect(check('HOME=/tmp/h; echo hi > ~/x', { rules: [deny({ writes: ['/tmp/h/*'] })], default: 'allow' }).decision).toBe('deny');
  });

  test('real paths participate in deny and ask matching, and are required for an allow match', () => {
    const fs = { readFile: () => null, realpath: (path: string) => (path === '/repo/link' ? '/outside/secret' : path) };
    const options = { cwd: '/repo', fs };
    expect(check('cat link', { rules: [deny({ args: ['/outside/**'] })], default: 'allow' }, options).decision).toBe('deny');
    expect(check('cat link', { rules: [allow({ args: ['/repo/link'] })], default: 'deny' }, options).decision).toBe('deny');
    expect(check('cat link', { rules: [allow({ args: ['/outside/**'] })], default: 'deny' }, options).decision).toBe('allow');
  });

  test('a path that does not exist yet is real under its deepest existing ancestor', () => {
    const real: Record<string, string> = { '/': '/', '/repo': '/repo', '/repo/src': '/repo/src', '/repo/etc': '/etc', '/etc': '/etc' };
    const options = { cwd: '/repo', fs: { readFile: () => null, realpath: (path: string) => real[path] ?? null } };
    const inside = { rules: [allow({ writes: ['/repo/**'] })], default: 'ask' as const };
    expect(check('touch new.txt', inside, options).decision).toBe('allow');
    expect(check('mkdir -p src/a/b', inside, options).decision).toBe('allow');
    expect(check('echo hi > src/new/out.txt', inside, options).decision).toBe('allow');
    expect(check('echo hi > etc/new', inside, options).decision).toBe('ask');
    expect(check('echo hi > etc/new', { rules: [deny({ writes: ['/etc/**'] })], default: 'allow' }, options).decision).toBe('deny');
    expect(check('touch new.txt', inside, { cwd: '/repo', fs: { readFile: () => null, realpath: () => null } }).decision).toBe('ask');
  });

  test('relative globs match from where the script starts, and its real path', () => {
    const inside = { rules: [ask({ writes: ['..', '../**'] })], default: 'allow' as const };
    expect(check('echo hi > /repo/out', inside, { cwd: '/repo' }).decision).toBe('allow');
    expect(check('echo hi > /srv/out', inside, { cwd: '/repo' }).decision).toBe('ask');
    expect(check('echo hi > /repo/out', inside).decision).toBe('ask');
    const real: Record<string, string> = { '/': '/', '/repo': '/data/repo', '/data': '/data', '/data/repo': '/data/repo' };
    const fs = { readFile: () => null, realpath: (path: string) => real[path] ?? null };
    expect(check('echo hi > out', inside, { cwd: '/repo', fs }).decision).toBe('allow');
    expect(check('echo hi > out', inside, { cwd: '/repo', fs: { readFile: () => null, realpath: () => undefined } }).decision).toBe('ask');
  });

  test('an allow rule matches where a path is, not how it is written', () => {
    const policy = { rules: [allow({ writes: ['src/**'] })], default: 'ask' as const };
    for (const environment of [{}, { cwd: '/repo' }]) {
      expect(check('echo x > src/a', policy, environment).decision).toBe('allow');
      expect(check('cd src && echo x > a', policy, environment).decision).toBe('allow');
      expect(check('cd /tmp && echo x > src/a', policy, environment).decision).toBe('ask');
      expect(check('cd .. && echo x > src/a', policy, environment).decision).toBe('ask');
      expect(check('cd $d && echo x > src/a', policy, environment).decision).toBe('ask');
    }
  });

  test('reasons point at the source', () => {
    const verdict = check('ls && rm -rf /', { rules: [deny('rm')], default: 'allow' });
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.analysis.source.slice(...verdict.reasons[0]!.span)).toBe('rm -rf /');
  });
});

describe('filesystem', () => {
  const tree: Record<string, string> = {
    '/repo/.git/HEAD': 'ref: refs/heads/main\n',
    '/repo/.git/config': '[core]\n\tbare = false\n',
    '/repo/.git/hooks/pre-commit': 'cat lint',
    '/repo/hooks/pre-commit': 'rm -rf /',
  };
  const dirs = new Set(['/', '/repo', '/repo/.git', '/repo/.git/objects', '/repo/.git/refs', '/repo/.git/hooks', '/repo/hooks', '/etc']);
  const links: Record<string, string> = { '/repo/out': '/repo/.git/hooks/pre-commit' };
  const fs = {
    readFile: (path: string) => tree[path] ?? null,
    realpath: (path: string) => links[path] ?? (path in tree || dirs.has(path) ? path : null),
  };
  const environment = { cwd: '/repo', fs };
  const unknown = (source: string) => analyze(source, environment).findings.some((finding) => finding.kind === 'unknown-file');

  test('a file the script may change before it is read is unknown', () => {
    for (const source of [
      'printf x > .git/hooks/pre-commit && git commit -m x',
      'cp -r hooks .git/ && git commit -m x',
      'mv hooks .git/hooks && git commit -m x',
      'git config user.name x && git status',
      "mkdir -p r/objects r/refs && echo 'ref: refs/heads/main' > r/HEAD && echo x > r/config && git --git-dir=r status",
      "mkdir -p r/objects r/refs && echo 'ref: refs/heads/main' > r/HEAD && cd r && git fetch o",
      'cp -r .git r && cd r && git show HEAD',
      'echo x > "$f" && git commit -m x',
      'echo x > out && git commit -m x',
      'if a; then cp -r hooks .git/; fi; git commit -m x',
      'for i in 1 2; do git commit -m x; cp -r hooks .git/; done',
      'bash -c "cp -r hooks .git/"; git commit -m x',
    ])
      expect([source, unknown(source)]).toEqual([source, true]);
    const changed = analyze('cp -r hooks .git/ && git commit -m x', environment);
    expect(changed.invocations.some((invocation) => invocation.program === 'cat')).toBe(false);
  });

  test('a program that may write files no spec names makes every later read unknown', () => {
    const kinds = (source: string) => [...new Set(analyze(source, environment).findings.map((finding) => finding.kind))];
    for (const source of [
      'python3 -c x && git commit -m x',
      './build.sh && git commit -m x',
      'npm install && git commit -m x',
      'git clone url dir && git commit -m x',
    ])
      expect([source, kinds(source)]).toEqual([source, ['unknown-file']]);
    // Project code it trusts but doesn't follow says so, for a policy that allows it to allow what follows.
    for (const source of ['make && git commit -m x', 'cargo build && git commit -m x', 'oxlint --fix src && git commit -m x'])
      expect([source, kinds(source)]).toEqual([source, ['project-file']]);
    expect(kinds('make && ./build.sh && git commit -m x')).toEqual(['unknown-file']);
    // A redirection names where it writes, whatever program it's on.
    for (const source of [
      'cat a > out.txt && git commit -m x',
      'grep x a > out.txt && git commit -m x',
      'jq . a >> out.txt && git commit -m x',
    ])
      expect([source, kinds(source)]).toEqual([source, []]);
    // recommended runs project code, so what it may have changed is no reason to ask; nor is a symlink it may have made.
    for (const source of ['cargo build && git commit -m x', 'cargo test && echo x > out.txt'])
      expect([source, check(source, recommended, environment).decision]).toEqual([source, 'allow']);
    // A symlink that was there before still leads where it leads.
    expect(check('cargo test && echo x > out', recommended, environment).decision).toBe('ask');
    // And what was there before is still walked: the hook git runs is that, or what project code wrote.
    const hooked = {
      cwd: '/repo',
      fs: { ...fs, readFile: (path: string) => (path === '/repo/.git/hooks/pre-commit' ? 'rm -rf /' : fs.readFile(path)) },
    };
    expect(check('cargo build && git commit -m x', recommended, hooked).decision).toBe('deny');
    expect(
      check('cargo build && git commit -m x', { ...recommended, rules: [...recommended.rules, ask({ effects: ['exec:project'] })] })
        .decision,
    ).toBe('ask');
  });

  test('git rewrites its work tree, but not its .git', () => {
    for (const source of ['git checkout main && git commit -m x', 'git stash && git commit -m x', 'git add . && git commit -m x'])
      expect([source, unknown(source)]).toEqual([source, false]);
    const project: Record<string, string> = {
      '/repo/.git/config': '[core]\n\thooksPath = hooks\n',
      '/repo/hooks/pre-commit': 'cat lint',
      '/repo/package.json': '{"scripts":{"test":"cat x"}}',
    };
    const fs = { readFile: (path: string) => project[path] ?? null, realpath: (path: string) => path };
    const environment = { cwd: '/repo', fs };
    const kinds = (source: string) => [...new Set(analyze(source, environment).findings.map((finding) => finding.kind))];
    for (const source of ['git commit -m x && npm test', 'git stash list && npm test', 'npm test && git commit -m x'])
      expect([source, kinds(source)]).toEqual([source, []]);
    // Whatever it checks out may hold anything: another branch, a commit, what was fetched, a patch, and even HEAD, the
    // index or a stash, which an earlier command (or this one) may have committed, staged or stashed.
    for (const source of [
      'git checkout main && git commit -m x',
      'git revert HEAD && npm test',
      'git merge origin/x && npm test',
      'git fetch origin pull/1/head && git checkout FETCH_HEAD -- package.json && npm test',
      'git restore -s origin/x . && npm test',
      'git apply x.patch && npm test',
      'git checkout package.json && npm test',
      'git reset --hard && npm test',
      'git stash pop && npm test',
      'git stash apply && npm test',
      'git fetch origin pull/1/head && git stash apply FETCH_HEAD && npm test',
      'git checkout -- package.json && npm test',
      'git checkout HEAD~1 -- package.json && npm test',
      'git restore --source=HEAD~1 . && npm test',
      'echo x > a && git add a && git mv -f a package.json && npm test',
    ]) {
      expect([source, kinds(source)]).toEqual([source, ['unknown-file']]);
      expect([source, check(source, recommended, environment).decision]).toEqual([source, 'ask']);
    }
    // Project code run where the checkout landed is no longer the project's own.
    expect(analyze('git checkout FETCH_HEAD && cargo build', environment).invocations.at(-1)?.effects).toContain('exec:file');
    project['/repo/hooks/pre-commit'] = 'rm -rf /';
    expect(check('git commit -m x', recommended, environment).decision).toBe('deny');
    // After a rewrite, the hook in the work tree isn't known: it asks.
    expect(check('git stash pop && git commit -m x', recommended, environment).decision).toBe('ask');
    // A commit may hold a symlink: where a path leads after a checkout isn't known.
    const write = analyze('git checkout main && echo x > out', environment).invocations.find((invocation) => invocation.program === 'echo');
    expect(write?.realpaths?.['/repo/out']).toBeNull();
  });

  test('what runs alongside may read what is written after it', () => {
    for (const source of [
      'git commit -m x | cp -r hooks .git/',
      'git commit -m x & cp -r hooks .git/',
      'cat <(git commit -m x); cp -r hooks .git/',
      'coproc git commit -m x; cp -r hooks .git/',
    ])
      expect([source, unknown(source)]).toEqual([source, true]);
  });

  test('reads before a write, and writes elsewhere, are known', () => {
    for (const source of [
      'git commit -m x && printf x > .git/hooks/pre-commit',
      'echo x > notes.txt && git commit -m x',
      'mkdir sub && cd sub && git status',
      'touch .git/hooks/x && chmod +x .git/hooks/pre-commit && git commit -m x',
      'git config user.name x',
    ])
      expect([source, unknown(source)]).toEqual([source, false]);
    const commit = analyze('echo x > notes.txt && git commit -m x', environment);
    expect(commit.invocations.some((invocation) => invocation.program === 'cat')).toBe(true);
  });

  test('a path the script may put a symlink on has no known real path', () => {
    const rules = [allow('rm|ln|mkdir|echo'), deny('rm', { args: ['/etc/**'] })];
    expect(check('rm e/passwd', { rules, default: 'ask' }, environment).decision).toBe('allow');
    expect(check('ln -s /etc e && rm e/passwd', { rules, default: 'ask' }, environment).decision).toBe('ask');
    expect(check('ln -s /etc e && rm e/passwd', { rules, default: 'ask', strict: true }, environment).decision).toBe('deny');
    const rm = analyze('ln -s /etc e && rm e/passwd', environment).invocations[1]!;
    expect(rm.realpaths).toEqual({ '/repo/e/passwd': null });
    const inside = { rules: [allow({ writes: ['/repo/**'] })], default: 'ask' as const };
    expect(check('mkdir d && echo x > d/f', inside, environment).decision).toBe('allow');
    expect(check('ln -s ~ h && echo x > h/.bashrc', inside, environment).decision).toBe('ask');
  });

  test('what the filesystem does not know is a need and a finding', () => {
    const analysis = analyze('git commit -m x', { cwd: '/repo/sub', fs: snapshot({}) });
    expect(analysis.needs).toContainEqual({ kind: 'file', path: '/repo/sub/.git/config' });
    expect(analysis.needs).toContainEqual({ kind: 'file', path: '/.git/config' });
    expect(analysis.findings.some((finding) => finding.kind === 'unknown-file')).toBe(true);
    expect(analyze('git commit -m x').needs).toEqual([]);
  });

  test('checkAsync fetches what each round needs, and decides as the sync check does', async () => {
    const remote = { readFile: async (path: string) => fs.readFile(path), realpath: async (path: string) => fs.realpath(path) };
    const hooked: Record<string, string> = { ...tree, '/repo/.git/hooks/pre-commit': 'rm -rf /' };
    const evil = { readFile: async (path: string) => hooked[path] ?? null, realpath: remote.realpath };
    expect((await checkAsync('git commit -m x', recommended, { cwd: '/repo', fs: remote })).decision).toBe('allow');
    expect((await checkAsync('git commit -m x', recommended, { cwd: '/repo', fs: evil })).decision).toBe('deny');
    expect(check('git commit -m x', recommended, environment).decision).toBe('allow');
    const short = await checkAsync('git commit -m x', recommended, { cwd: '/repo', fs: remote }, { rounds: 1 });
    expect(short.decision).toBe('ask');
    expect(short.analysis.needs.length).toBeGreaterThan(0);
  });
});
