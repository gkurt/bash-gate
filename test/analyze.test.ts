import { describe, expect, test } from 'bun:test';
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
    expect(analyze('cd /srv; cd app; ls').invocations.at(-1)!.cwd).toBe('/srv/app');
    expect(analyze('cd /srv && ls').invocations.at(-1)!.cwd).toBe('/srv');
    // After `a && b`, either may have been the last to run, so a cd in `b` leaves the directory unknown.
    expect(analyze('cd /srv && cd app; ls').invocations.at(-1)!.cwd).toBeUndefined();
    expect(analyze('cd "$d"; ls').invocations.at(-1)!.cwd).toBeUndefined();
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
    '/repo/.git/config': '[core]\n\tbare = false\n',
    '/repo/.git/hooks/pre-commit': 'cat lint',
    '/repo/hooks/pre-commit': 'rm -rf /',
  };
  const dirs = new Set(['/', '/repo', '/repo/.git', '/repo/.git/hooks', '/repo/hooks', '/etc']);
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
    for (const source of [
      'make && git commit -m x',
      'cargo build && git commit -m x',
      'python3 -c x && git commit -m x',
      './build.sh && git commit -m x',
      'npm install && git commit -m x',
      'git clone url dir && git commit -m x',
    ])
      expect([source, unknown(source)]).toEqual([source, true]);
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
    const changed = (source: string) => analyze(source, { cwd: '/repo', fs }).findings.some((finding) => finding.kind === 'unknown-file');
    for (const source of [
      'git checkout main && git commit -m x',
      'git reset --hard && npm test',
      'git stash pop && npm test',
      'git stash apply && npm test',
      'git revert HEAD && npm test',
    ])
      expect([source, changed(source)]).toEqual([source, true]);
    for (const source of ['git commit -m x && npm test', 'git stash list && npm test', 'npm test && git commit -m x'])
      expect([source, changed(source)]).toEqual([source, false]);
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
