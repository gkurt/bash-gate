import { anyWords, flag, isOption, normalize, readCobra, type CommandSpec, type OptionSpec, type Parsed } from './argv.ts';
import type { Arg, Effect } from './types.ts';
import { dynamicArg, resolveWords } from './words.ts';

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
  plus: true,
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
    '-b',
    '-h',
    '-k',
    '-m',
    '-t',
    '-B',
    '-C',
    '-E',
    '-H',
    '-P',
    '-T',
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
    // A lone `-` ends the options, like `--`: the script file is the word after it, if any.
    const [file] = first?.kind === 'static' && first.value === '-' ? parsed.positionals.slice(1) : parsed.positionals;
    if (parsed.options['-c']) {
      if (first) parsed.scripts.push(first);
    } else if (parsed.maybeOptions) {
      // A word only known at run time may be -c, which makes the first positional after it code.
      parsed.scripts.push(...parsed.positionals);
      parsed.effects.add('exec:arbitrary');
    } else if (file && !parsed.options['-s']) {
      parsed.effects.add('exec:file');
      parsed.reads.push(file);
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

/** A word a package manager runs as a file rather than a script: a path, or a JavaScript or TypeScript file. */
const scriptFile = /[\\/]|^\.|\.[cm]?[jt]sx?$|\.(json|toml|wasm|sh)$/i;

/**
 * A package manager running `name`: a package.json script, which is project code, or else a file (`bun f` runs
 * `f.ts`), or with `fallback` a command from PATH with the words after it (`pnpm node -e …`). The analysis drops that
 * command once the filesystem shows the script is there. A name only known at run time may be one of its own commands.
 */
function runsScript(parsed: Parsed, name: Arg, fallback: boolean): void {
  if (fallback) parsed.nested.push({ argv: parsed.positionals.slice(parsed.positionals.indexOf(name)), open: false });
  if (name.kind === 'dynamic') {
    parsed.effects.add('exec:arbitrary');
  } else if (!fallback && scriptFile.test(name.value)) {
    parsed.effects.add('exec:file');
    parsed.reads.push(name);
  } else {
    parsed.effects.add('exec:project');
  }
}

/**
 * An option it doesn't know is configuration, which may say what runs: npm's `--script-shell`, vitest's
 * `--globalSetup` spelled another way. So is one a word only known at run time may be.
 */
function unknownIsConfig(parsed: Parsed): void {
  if (parsed.unknownOptions.length > 0 || parsed.maybeOptions) parsed.effects.add('exec:arbitrary');
}

/** `npm pkg set`, `npm version`: the package.json where it runs, whose scripts later commands run. */
function writesManifest(parsed: Parsed): void {
  parsed.effects.add('fs:write');
  const cwd = parsed.cwd;
  if (!cwd) parsed.writes.push({ kind: 'static', value: 'package.json' });
  else if (cwd.kind === 'static') parsed.writes.push({ kind: 'static', value: `${cwd.value.replace(/\/+$/, '')}/package.json` });
  else parsed.writes.push(dynamicArg(`${cwd.text}/package.json`, cwd.reason, false, cwd.prefix));
}

/**
 * `npm pack <spec>`: another package, from a directory (whose scripts it runs as it packs), the registry or a git
 * host (which it clones, installs and runs `prepare` in). Only `.` is the project's.
 */
function packsElsewhere(parsed: Parsed): void {
  for (const spec of parsed.positionals) {
    const value = staticValue(spec);
    if (value !== undefined && /^\.\/*$/.test(value)) continue;
    if (value !== undefined && /^[.~/]/.test(value)) parsed.effects.add('exec:file');
    else parsed.effects.add('network').add('exec:arbitrary');
  }
}

/** `npm config`: a key it sets may name the shell every later command's scripts run in. */
function setsConfig(parsed: Parsed): void {
  const verb = parsed.positionals[0];
  if (!verb || (verb.kind === 'static' && /^(get|list|ls)$/.test(verb.value))) return;
  parsed.effects.add('exec:arbitrary');
}

const pnpmOptions = opts(
  o('-C= --dir=', { role: 'cwd' }),
  '-w --workspace-root',
  '-r --recursive',
  '-F= --filter=',
  '--filter-prod=',
  '--test-pattern=',
  '--changed-files-ignore-pattern=',
  '--fail-if-no-match',
  '-s --silent',
  '--reporter=',
  '--loglevel=',
  '--color',
  '--no-color',
  '--aggregate-output',
  '--stream',
  '--parallel',
  '--workspace-concurrency=',
  '--if-present',
  '--resume-from=',
  '--report-summary',
  '--sort',
  '--no-sort',
  '--reverse',
  '--bail',
  '--no-bail',
  '--ignore-scripts',
  '--use-stderr',
  '--frozen-lockfile',
  '--offline',
  '--prefer-offline',
  '-D --save-dev',
  '-P --save-prod',
  '-O --save-optional',
  '-E --save-exact',
  '-g --global',
  '-h --help',
  '-v --version',
);

/** bun's own options, which come before the script or file it runs. */
const bunOptions = opts(
  '--silent',
  '--elide-lines=',
  '-v --version',
  '--revision',
  '-F= --filter=',
  '-b --bun',
  '--no-orphans',
  '--shell=',
  '--workspaces',
  '--parallel',
  '--sequential',
  '--no-exit-on-error',
  '--watch',
  '--watch-kill-signal=',
  '--hot',
  '--no-clear-screen',
  '--check',
  '--smol',
  o('--interactive', { effects: ['exec:arbitrary'] }),
  o('-r= --preload= --require= --import=', { role: 'read', effects: ['exec:file'] }),
  o('--inspect=? --inspect-wait=? --inspect-brk=?', { effects: ['network'] }),
  '--cpu-prof',
  o('--cpu-prof-name= --cpu-prof-dir= --heap-prof-name= --heap-prof-dir=', { effects: ['fs:write'] }),
  '--cpu-prof-md',
  '--cpu-prof-interval=',
  '--heap-prof',
  '--heap-prof-md',
  '--heap-prof-interval=',
  '--if-present',
  '--no-install',
  '--install=',
  '-i',
  inline('-e= --eval='),
  inline('-p= --print='),
  '--prefer-offline',
  '--prefer-latest',
  '--port=',
  '--conditions=',
  o('--fetch-preconnect=', { effects: ['network'] }),
  '--experimental-http2-fetch',
  '--experimental-http3-fetch',
  '--max-http-header-size=',
  '--insecure-http-parser',
  '--dns-result-order=',
  '--experimental-stream-iter',
  '--expose-gc',
  '--no-deprecation',
  '--throw-deprecation',
  '--no-warnings',
  '--trace-warnings',
  '--trace-deprecation',
  '--pending-deprecation',
  o('--redirect-warnings=', { role: 'write' }),
  '--disable-warning=',
  '--title=',
  '--zero-fill-buffers',
  '--use-system-ca',
  '--use-openssl-ca',
  '--use-bundled-ca',
  '--tls-min-v1.0',
  '--tls-min-v1.1',
  '--tls-min-v1.2',
  '--tls-min-v1.3',
  '--tls-max-v1.2',
  '--tls-max-v1.3',
  o('--redis-preconnect --sql-preconnect', { effects: ['network'] }),
  '--no-addons',
  '--no-ffi-cc',
  '--unhandled-rejections=',
  '--console-depth=',
  '--user-agent=',
  '--cron-title=',
  '--cron-period=',
  '--main-fields=',
  '--preserve-symlinks',
  '--preserve-symlinks-main',
  '--extension-order=',
  // A tsconfig's `paths` and a JSX import source decide which modules run.
  o('--tsconfig-override=', { role: 'read', effects: ['exec:file'] }),
  '-d= --define=',
  '--drop=',
  '--feature=',
  '-l= --loader=',
  '--no-macros',
  '--jsx-factory=',
  '--jsx-fragment=',
  o('--jsx-import-source=', { effects: ['exec:file'] }),
  '--jsx-runtime=',
  '--jsx-side-effects',
  '--ignore-dce-annotations',
  // What it sets may load code: `NODE_OPTIONS=--require …`.
  o('--env-file=', { role: 'read', effects: ['exec:file'] }),
  '--no-env-file',
  o('--cwd=', { role: 'cwd' }),
  // bunfig.toml may preload modules.
  o('-c= --config=', { role: 'read', effects: ['exec:file'] }),
  '-h --help',
);

/** Options every cargo command takes. `--config` and `-Z` may set what runs (`build.rustc-wrapper`, `target.*.runner`). */
const cargoGlobal = opts(
  '-V --version',
  '--list',
  '--explain=',
  '-v --verbose',
  '-q --quiet',
  '--color=',
  o('-C=', { role: 'cwd' }),
  '--locked',
  '--offline',
  '--frozen',
  o('--config=', { effects: ['exec:arbitrary'] }),
  o('-Z=', { effects: ['exec:arbitrary'] }),
  '-h --help',
);

/** A project's manifest elsewhere is another project's code. */
const manifestPath = o('--manifest-path=', { role: 'read', effects: ['exec:file'] });

const cargoOptions = [
  ...cargoGlobal,
  manifestPath,
  ...opts(
    o('--target-dir=', { role: 'write' }),
    o('--artifact-dir= --out-dir=', { role: 'write' }),
    '-p= --package=',
    '--workspace --all',
    '--exclude=',
    '-F= --features=',
    '--all-features',
    '--no-default-features',
    '--lib',
    '--bins',
    '--bin=',
    '--examples',
    '--example=',
    '--tests',
    '--test=',
    '--benches',
    '--bench=',
    '--all-targets',
    '-r --release',
    '--profile=',
    '-j= --jobs=',
    '--keep-going',
    '--target=',
    '--message-format=',
    '--timings=?',
    '--ignore-rust-version',
    '--future-incompat-report',
    '--unit-graph',
    '--no-run',
    '--no-fail-fast',
    '--doc',
    '--open',
    '--no-deps',
    '--document-private-items',
    o('--fix', { effects: ['fs:write'] }),
    '--allow-dirty',
    '--allow-staged',
    '--allow-no-vcs',
    '--broken-code',
    '--check',
    '--dry-run',
    '-D --dev',
    '--build',
    '--optional',
    '--rename=',
    '--registry=',
    '--git=',
    '--path=',
    '--branch=',
    '--tag=',
    '--rev=',
    '--precise=',
    '--recursive',
    '--root=',
    '-f --force',
  ),
];

/** `cargo new` and `init` take `--bin` alone, and write where their positional says. */
const cargoNew = [...cargoGlobal, manifestPath, ...opts('--bin', '--lib', '--name=', '--vcs=', '--edition=', '--registry=')];

/**
 * A linter's fixes or a formatter's rewrites, when `writing`: the files and directories its positionals name, or with
 * `here` the working directory when there are none.
 */
function rewrites(parsed: Parsed, writing: boolean, here = true): void {
  if (!writing) return;
  parsed.effects.add('fs:write');
  const roots: Arg[] = parsed.positionals.length > 0 ? parsed.positionals : here ? [{ kind: 'static', value: '.' }] : [];
  parsed.writes.push(...roots);
  (parsed.edited ??= []).push(...roots);
}

/** `--init` and the like: a configuration file where it runs. */
function writesFile(parsed: Parsed, name: string): void {
  parsed.effects.add('fs:write');
  parsed.writes.push({ kind: 'static', value: name });
}

/** `args` are files it runs, or finds configuration beside (see `Parsed.loads`). */
function loadsFrom(parsed: Parsed, args: (Arg | true)[]): void {
  for (const arg of args) if (arg !== true) (parsed.loads ??= []).push(arg);
}

const given = (parsed: Parsed, ...names: string[]) => names.some((name) => parsed.options[name] !== undefined);

/** Options spelled in camelCase, each also in kebab-case, as yargs and cac read them: `--setupFiles`, `--setup-files`. */
function camel(...spellings: string[]): string[] {
  return spellings.map((spelling) =>
    spelling
      .split(' ')
      .flatMap((name) => {
        if (!name.startsWith('--')) return [name];
        const kebab = name.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        return kebab === name ? [name] : [name, kebab];
      })
      .join(' '),
  );
}

/**
 * Options whose value is a module it loads: with `always`, whatever it is (a config file, a setup file), else only a
 * path (`--reporter=./r.ts`, where `--reporter=verbose` names one of its own). A module is code from wherever it is.
 */
function loadsModules(parsed: Parsed, names: string[], always = false): void {
  for (const value of names.flatMap((name) => parsed.options[name] ?? [])) {
    if (value === true || (!always && value.kind === 'static' && !scriptFile.test(value.value))) continue;
    parsed.effects.add('exec:file');
    parsed.reads.push(value);
  }
}

const vitestOptions = opts(
  ...camel(
    '-v --version',
    '-h --help',
    '-r= --root=',
    '--dir=',
    '-c= --config=',
    '-u --update',
    '-w --watch',
    '--no-watch',
    '-t= --testNamePattern=',
    '--workspace=',
    '--project=',
    '--open',
    '--silent=?',
    '--hideSkippedTests',
    '--reporter=',
    '--coverage',
    '--no-coverage',
    '--mode=',
    '--isolate',
    '--no-isolate',
    '--globals',
    '--dom',
    '--browser=?',
    '--pool=',
    '--poolOptions=',
    '--fileParallelism',
    '--no-file-parallelism',
    '--maxWorkers=',
    '--minWorkers=',
    '--environment=',
    '--passWithNoTests',
    '--logHeapUsage',
    '--allowOnly',
    '--dangerouslyIgnoreUnhandledErrors',
    '--shard=',
    '--changed=?',
    '--sequence=',
    '--testTimeout=',
    '--hookTimeout=',
    '--bail=',
    '--retry=',
    '--diff=',
    '--exclude=',
    '--expandSnapshotDiff',
    '--disableConsoleIntercept',
    '--typecheck',
    '--slowTestThreshold=',
    '--teardownTimeout=',
    '--cache',
    '--no-cache',
    '--maxConcurrency=',
    '--expect',
    '--printConsoleTrace',
    '--includeTaskLocation',
    '--run',
    '--no-color',
    '--clearScreen',
    '--configLoader=',
    '--standalone',
    '--mergeReports=?',
  ),
  o(camel('--outputFile=')[0]!, { role: 'write' }),
  // A server that runs tests on request, or a debugger: code from whoever reaches it.
  ...camel('--ui', '--api=?', '--inspect=?', '--inspectBrk=?').map((spellings) => o(spellings, { effects: ['network'] })),
);

const jestOptions = opts(
  ...camel(
    '-h --help',
    '--version',
    '--all',
    '--automock',
    '-b --bail=?',
    '--cache',
    '--no-cache',
    '--cacheDirectory=',
    '--changedFilesWithAncestor',
    '--changedSince=',
    '--ci',
    '--clearCache',
    '--clearMocks',
    '--collectCoverage',
    '--collectCoverageFrom=',
    '--color',
    '--colors',
    '--coverage',
    '--coverageDirectory=',
    '--coveragePathIgnorePatterns=',
    '--coverageProvider=',
    '--coverageReporters=',
    '--coverageThreshold=',
    '--debug',
    '--detectLeaks',
    '--detectOpenHandles',
    '--errorOnDeprecated',
    '-e --expand',
    '--findRelatedTests',
    '--forceExit',
    '--globals=',
    '--ignoreProjects=',
    '--injectGlobals',
    '--json',
    '--lastCommit',
    '--listTests',
    '--logHeapUsage',
    '--maxConcurrency=',
    '-w= --maxWorkers=',
    '--moduleFileExtensions=',
    '--modulePathIgnorePatterns=',
    '--noStackTrace',
    '--notify',
    '--notifyMode=',
    '-o --onlyChanged',
    '-f --onlyFailures',
    '--openHandlesTimeout=',
    '--passWithNoTests',
    '--randomize',
    '--resetMocks',
    '--resetModules',
    '--restoreMocks',
    '-i --runInBand',
    '--runTestsByPath',
    '--seed=',
    '--selectProjects=',
    '--shard=',
    '--showConfig',
    '--showSeed',
    '--silent',
    '--testEnvironmentOptions=',
    '--testFailureExitCode=',
    '--testLocationInResults',
    '--testMatch=',
    '-t= --testNamePattern=',
    '--testPathIgnorePatterns=',
    '--testPathPattern=',
    '--testRegex=',
    '--testTimeout=',
    '--transformIgnorePatterns=',
    '--unmockedModulePathPatterns=',
    '-u --updateSnapshot',
    '--useStderr',
    '--verbose',
    '--watch',
    '--watchAll',
    '--watchPathIgnorePatterns=',
    '--watchman',
    '--no-watchman',
    '--workerThreads',
  ),
  o(camel('--outputFile=')[0]!, { role: 'write' }),
);

/** jest's options that name code it loads, whatever their value: a config may be JSON naming more. */
const jestModules = camel(
  '-c= --config=',
  '--env=',
  '--filter=',
  '--globalSetup=',
  '--globalTeardown=',
  '--haste=',
  '--init',
  '--moduleDirectories=',
  '--moduleNameMapper=',
  '--modulePaths=',
  '--preset=',
  '--prettierPath=',
  '--projects=',
  '--reporters=',
  '--resolver=',
  '--rootDir=',
  '--roots=',
  '--runner=',
  '--setupFiles=',
  '--setupFilesAfterEnv=',
  '--snapshotSerializers=',
  '--testEnvironment=',
  '--testResultsProcessor=',
  '--testRunner=',
  '--testSequencer=',
  '--transform=',
);

const viteCommon = camel(
  '-c= --config=',
  '--base=',
  '-l= --logLevel=',
  '--clearScreen',
  '--configLoader=',
  '-d --debug=?',
  '-f= --filter=',
  '-m= --mode=',
  '-h --help',
  '-v --version',
);
const viteServer = opts(
  ...viteCommon,
  ...camel('--port=', '--open=?', '--cors', '--strictPort', '--force'),
  // Its dev server and preview listen beyond this machine with --host.
  o('--host=?', { effects: ['network'] }),
);
const viteBuild = opts(
  ...viteCommon,
  ...camel(
    '--target=',
    '--assetsDir=',
    '--assetsInlineLimit=',
    '--ssr=?',
    '--sourcemap=?',
    '--minify=?',
    '--manifest=?',
    '--ssrManifest=?',
    '--emptyOutDir',
    '-w --watch',
    '--app',
  ),
  o(camel('--outDir=')[0]!, { role: 'write' }),
);

/**
 * What tsc emits: JavaScript, declarations, source maps and build info, beside the sources or under its outDir, and with
 * resolveJsonModule the JSON its sources import, copied there from wherever they are.
 */
const tscEmits = /\.([cm]?js|jsx|d\.[cm]?ts|map|tsbuildinfo|json)$/;

/** What biome formats and fixes. A JSON formatter keeps every value, so a package.json's scripts stay what they were. */
const biomeEdits = /(?<!(?:^|\/)package)\.(jsonc?|[cm]?[jt]sx?|css|graphql|gql|html|vue|svelte|astro|grit)$/;

const biomeOptions = opts(
  o('--config-path=', { role: 'read' }),
  '--write',
  '--fix',
  '--apply',
  '--apply-unsafe',
  '--unsafe',
  '--staged',
  '--changed',
  '--since=',
  '--only=',
  '--skip=',
  '--reporter=',
  '--diagnostic-level=',
  '--max-diagnostics=',
  '--error-on-warnings',
  '--no-errors-on-unmatched',
  '--files-ignore-unknown=',
  '--formatter-enabled=',
  '--linter-enabled=',
  '--assist-enabled=',
  '--vcs-enabled=',
  '--vcs-client-kind=',
  '--vcs-use-ignore-file=',
  '--vcs-root=',
  '--vcs-default-branch=',
  '--stdin-file-path=',
  '--colors=',
  '--use-server',
  '--verbose',
  '--skip-parse-errors',
  '--threads=',
  '--log-level=',
  '--log-kind=',
  o('--log-file=', { role: 'write' }),
  '-h --help',
  '-V --version',
);

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
  /^(alias\..*|core\.(pager|editor|sshcommand|fsmonitor|hookspath|askpass|gitproxy|worktree)|sequence\.editor|pager\..*|diff\.external|diff\..*\.(command|textconv)|merge\..*\.driver|filter\..*\.(clean|smudge|process)|credential\.helper|credential\..*\.helper|gpg\.program|gpg\..*\.program|interactive\.difffilter|uploadpack\.packobjectshook|remote\..*\.(uploadpack|receivepack|vcs)|protocol\..*\.allow|url\..*|include\.path|includeif\..*|submodule\..*\.update|ssh\.variant|core\.sshcommand|http\..*proxy|web\.browser|browser\..*\.(cmd|path)|man\..*\.(cmd|path)|sendemail\..*cmd|mergetool\..*\.cmd|difftool\..*\.cmd|hook\..*\.command|gpg\.ssh\.defaultkeycommand|trailer\..*\.(command|cmd)|core\.alternaterefscommand|gc\.recentobjectshook)$/;

/** Keys whose value is a command git runs with the shell. */
const gitShellKeys =
  /^(hook\..*\.command|trailer\..*\.(command|cmd)|core\.(pager|editor|sshcommand|fsmonitor|askpass|alternaterefscommand)|gc\.recentobjectshook|sequence\.editor|pager\..*|diff\.external|diff\..*\.(command|textconv)|merge\..*\.driver|filter\..*\.(clean|smudge|process)|gpg\.program|interactive\.difffilter|uploadpack\.packobjectshook|browser\..*\.cmd|man\..*\.cmd|mergetool\..*\.cmd|difftool\..*\.cmd)$/;

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

/** `git config` names a subcommand first, or none (`git config key value`): a key always has a dot. */
const configSubcommands = new Set(['list', 'get', 'set', 'unset', 'rename-section', 'remove-section', 'edit']);

/**
 * `git config key value` (and `--add`, `--replace-all`, `git config set key value`) sets an entry: read like
 * `-c key=value`. Unsetting and renaming write the file too.
 */
function finishConfig(parsed: Parsed): void {
  const first = staticValue(parsed.positionals[0]);
  if (parsed.positionals[0] && first === undefined) parsed.maybeOptions = true;
  const subcommand = first !== undefined && configSubcommands.has(first) ? first : undefined;
  const positionals = subcommand ? parsed.positionals.slice(1) : parsed.positionals;
  const reading = ['--get', '--get-all', '--get-regexp', '--list', '--get-urlmatch', '--get-color', '--get-colorbool'];
  if (subcommand === 'get' || subcommand === 'list' || reading.some((name) => parsed.options[name])) return;
  // The file it writes: the one named, the user's, the system's, the work tree's, or the repository's.
  const file = parsed.options['--file']?.[0];
  const scope = parsed.options['--global'] ? '~/.gitconfig' : parsed.options['--system'] ? '/etc/gitconfig' : undefined;
  const named: Arg | undefined = file !== undefined && file !== true ? file : undefined;
  const target: Arg = named ?? { kind: 'static', value: scope ?? (parsed.options['--worktree'] ? '.git/config.worktree' : '.git/config') };
  const removing = ['--unset', '--unset-all', '--remove-section', '--rename-section'];
  // `edit` opens the file in an editor, as `-e` does.
  if (subcommand === 'edit') {
    parsed.effects.add('exec:arbitrary');
    parsed.writes.push(target);
    return;
  }
  if (subcommand === 'unset' || subcommand?.endsWith('-section') || removing.some((name) => parsed.options[name])) {
    parsed.effects.add('fs:write');
    parsed.writes.push(target);
    return;
  }
  const [key, value] = positionals;
  if (!key || !value) return;
  parsed.effects.add('fs:write');
  parsed.writes.push(target);
  const k = staticValue(key);
  const v = staticValue(value);
  parsed.configs.push(k !== undefined && v !== undefined ? { kind: 'static', value: `${k}=${v}` } : value);
}

/** `git reflog expire`, `delete` and `drop` remove entries: a stash is one. */
function finishReflog(parsed: Parsed): void {
  const first = parsed.positionals[0];
  if (first?.kind === 'dynamic' || ['expire', 'delete', 'drop'].includes(first?.value ?? '')) parsed.effects.add('fs:delete');
}

/**
 * `git checkout` and `git restore` write the paths they're given, which may be outside the working directory when the
 * repository is larger. A word naming `HEAD` or a commit from it is no path.
 */
function finishTreePaths(parsed: Parsed): void {
  for (const arg of parsed.positionals) if (!/^(?:[A-Z_]*HEAD|@)(?:[~^]\d*)*$/.test(staticValue(arg) ?? '')) parsed.writes.push(arg);
}

const force = (parsed: Parsed) => (parsed.options['--force'] ??= []).push(true);

/**
 * `git checkout` forces what it overwrites: `-B` resets a branch that's there, and `--ours`, `--theirs` or paths after
 * a commit (`git checkout HEAD~3 -- .`) overwrite uncommitted changes. One word alone may be a branch or a path.
 */
function finishCheckout(parsed: Parsed): void {
  finishTreePaths(parsed);
  // A word git refuses as a branch name (`.`, `src/`, `a..b`, `*.ts`) is a path.
  const path = parsed.positionals.some((arg) => arg.kind === 'static' && /^\.|\/$|\.\.|\/\.|[\s~^:?*[\\]|\.lock$|^-|^$/.test(arg.value));
  // After `--`, or from a file, words are paths; `-m` and `--conflict` check out paths as they were merged.
  const paths = (parsed.separated === true && parsed.positionals.length > 0) || parsed.positionals.length > 1 || path;
  const named = ['-B', '--ours', '--theirs', '--pathspec-from-file', '--merge', '--conflict', '--patch'].some(
    (name) => parsed.options[name],
  );
  if (paths || named) force(parsed);
}

/** `git switch -C` resets a branch that's there. */
function finishSwitch(parsed: Parsed): void {
  if (parsed.options['--force-create']) force(parsed);
}

/** `git restore` writes the work tree unless only `--staged` says where. */
function finishRestore(parsed: Parsed): void {
  finishTreePaths(parsed);
  if (!parsed.options['--staged']) (parsed.options['--worktree'] ??= []).push(true);
}

/** `git mv a b` writes `b`, or `b/a` when `b` is a directory, and removes `a`. */
function finishGitMove(parsed: Parsed): void {
  const target = parsed.positionals.at(-1);
  const into = staticValue(target)?.replace(/\/+$/, '');
  parsed.writes.push(...parsed.positionals);
  for (const source of parsed.positionals.slice(0, -1)) {
    const name = staticValue(source)?.replace(/\/+$/, '').split('/').pop();
    parsed.writes.push(
      into !== undefined && name ? { kind: 'static', value: `${into}/${name}` } : dynamicArg(`${into ?? '…'}/…`, 'placeholder', false, ''),
    );
  }
}

/** The merge strategies git has: another (`-s evil`) is `git-merge-evil`, found on PATH. */
const mergeStrategies = new Set(['ort', 'recursive', 'resolve', 'octopus', 'ours', 'subtree']);

function finishStrategy(parsed: Parsed): void {
  for (const strategy of parsed.options['--strategy'] ?? [])
    if (strategy === true || strategy.kind === 'dynamic' || !mergeStrategies.has(strategy.value)) parsed.effects.add('exec:arbitrary');
}

const hooks: Effect[] = ['fs:write', 'exec:project'];

/** With no command, `unshare` and `chroot` run `$SHELL` (else `/bin/sh`), which reads its input or a terminal. */
function shellWithout(parsed: Parsed): void {
  if (parsed.nested.length === 0) parsed.effects.add('exec:arbitrary');
}

/** A git remote by its name: where it leads is what the repository's config says, not the command line. */
const remoteName = /^\w[\w.-]*$/;

/**
 * `git fetch` and `ls-remote` only read from a remote the repository already has (`network:read`), unless the command
 * line says where to go: a URL or a path, config of its own, another repository, or words it's unsure of.
 */
function finishRemoteRead(parsed: Parsed): void {
  const repositories = parsed.options['--multiple'] ? parsed.positionals : parsed.positionals.slice(0, 1);
  // Refspecs read from standard input may be any: `+` ones, or ones --prune deletes local branches by.
  if (parsed.options['--stdin']) (parsed.options['--force'] ??= []).push(true);
  // A `+` refspec forces the update of what it names, as `--force` does for all.
  for (const refspec of parsed.positionals.slice(repositories.length)) {
    const value = staticValue(refspec);
    if (value === undefined) parsed.maybeOptions = true;
    else if (value.startsWith('+')) (parsed.options['--force'] ??= []).push(refspec);
    // With --prune, a refspec into local branches or tags (`refs/heads/*:refs/heads/*`) deletes the ones the remote
    // doesn't have, as --prune-tags does for tags.
    const destination = value?.split(':')[1];
    if (parsed.options['--prune'] && destination !== undefined && !destination.startsWith('refs/remotes/'))
      (parsed.options['--force'] ??= []).push(refspec);
  }
  const named = repositories.every((arg) => arg.kind === 'static' && remoteName.test(arg.value));
  const elsewhere =
    parsed.unknownOptions.length > 0 ||
    parsed.maybeOptions ||
    parsed.configs.length > 0 ||
    ['--git-dir', '--work-tree', '--namespace', '--exec-path'].some((name) => parsed.options[name] !== undefined);
  parsed.effects.add(named && !elsewhere ? 'network:read' : 'network');
}

/** `git remote add`, `set-url` and the like rewrite the repository's config: where its fetches and pushes go. */
function finishRemoteEdit(parsed: Parsed): void {
  parsed.writes.push({ kind: 'static', value: '.git/config' });
}

const git: CommandSpec = {
  options: opts(
    o('-C=', { role: 'cwd' }),
    o('-c=', { role: 'config' }),
    o('--config-env=', { role: 'config' }),
    o('--exec-path=?', { effects: ['exec:file'] }),
    '--git-dir=',
    '--work-tree=',
    '--namespace=',
    '--attr-source=',
    '--shallow-file=',
    '--super-prefix=',
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
    // Those that take the diff and log options write `--output`.
    ...each('blame annotate shortlog rev-list whatchanged', { abbreviations: true, options: opts(o('--output=', { role: 'write' })) }),
    // `expire`, `delete` and `drop` remove entries (a stash is one), and `show` (by default) writes `--output`.
    reflog: { abbreviations: true, options: opts(o('--output=', { role: 'write' })), finish: finishReflog },
    ...each(
      'describe rev-parse ls-files ls-tree show-ref cat-file merge-base name-rev count-objects var check-ignore check-attr for-each-ref version',
      { abbreviations: true },
    ),
    // `-w` opens the page in a browser, found as git's web--browse finds one.
    help: {
      abbreviations: true,
      options: opts(o('-w --web', { effects: ['exec:arbitrary'] }), '-a --all', '-g --guides', '-i --info', '-m --man'),
    },
    'ls-remote': {
      abbreviations: true,
      options: opts(
        '-q --quiet',
        o('--upload-pack= --exec=', { effects: ['exec:arbitrary'] }),
        '-t --tags',
        '-b --branches',
        '-h --heads',
        '--refs',
        '--get-url',
        '--sort=',
        '--exit-code',
        '--symref',
        '-o= --server-option=',
      ),
      finish: finishRemoteRead,
    },
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
        '--verify --no-no-verify',
        '--fixup=',
        '--squash=',
        '-C= --reuse-message=',
        '-c= --reedit-message=',
        '-e --edit',
        '--no-edit',
        '-S=? --gpg-sign=?',
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
        '--verify --no-no-verify',
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
        '--verify --no-no-verify',
        '-s= --strategy=',
        '-X= --strategy-option=',
        o('--upload-pack=', { effects: ['exec:arbitrary'] }),
      ),
      finish: finishStrategy,
    },
    fetch: {
      abbreviations: true,
      effects: ['fs:write'],
      options: opts(
        '-v --verbose',
        '-q --quiet',
        '--all',
        '--set-upstream',
        '-a --append',
        '--atomic',
        o('--upload-pack=', { effects: ['exec:arbitrary'] }),
        '-f --force',
        '-m --multiple',
        '-t --tags',
        '-n --no-tags',
        '-j= --jobs=',
        '--prefetch',
        '-p --prune',
        '-P --prune-tags',
        '--stdin',
        '--recurse-submodules=?',
        '--no-recurse-submodules',
        '--dry-run',
        '--porcelain',
        '--write-fetch-head',
        '--no-write-fetch-head',
        '-k --keep',
        '-u --update-head-ok',
        '--progress',
        '--depth=',
        '--shallow-since=',
        '--shallow-exclude=',
        '--deepen=',
        '--unshallow',
        '--refetch',
        '--update-shallow',
        '--refmap=',
        '-o= --server-option=',
        '-4 --ipv4',
        '-6 --ipv6',
        '--negotiation-restrict=',
        '--negotiation-tip=',
        '--negotiation-include=',
        '--negotiate-only',
        '--filter=',
        '--auto-maintenance',
        '--no-auto-maintenance',
        '--auto-gc',
        '--no-auto-gc',
        '--show-forced-updates',
        '--no-show-forced-updates',
        '--write-commit-graph',
        '--stdin',
      ),
      finish: finishRemoteRead,
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
        '-2 --ours',
        '-3 --theirs',
        '-m --merge',
        '--conflict=',
        '--pathspec-from-file=',
        '--pathspec-file-nul',
        '-q --quiet',
      ),
      finish: finishCheckout,
    },
    switch: {
      abbreviations: true,
      effects: hooks,
      options: opts('-c= --create=', '-C= --force-create=', '-f --force --discard-changes', '-d --detach', '--orphan=', '-t --track=?'),
      finish: finishSwitch,
    },
    restore: {
      abbreviations: true,
      effects: ['fs:write'],
      options: opts('-s= --source=', '-S --staged', '-W --worktree', '-p --patch'),
      finish: finishRestore,
    },
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
      // `-D`, `-M` and `-C` are `--delete`, `--move` and `--copy` with `--force`.
      finish(parsed) {
        for (const [short, long] of [
          ['-D', '--delete'],
          ['-M', '--move'],
          ['-C', '--copy'],
        ] as const) {
          if (!parsed.options[short]) continue;
          (parsed.options[long] ??= []).push(true);
          (parsed.options['--force'] ??= []).push(true);
        }
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
        '--verify --no-no-verify',
        '--allow-unrelated-histories',
      ),
      finish: finishStrategy,
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
        '--verify --no-no-verify',
        '--update-refs',
      ),
      finish: finishStrategy,
    },
    ...each('cherry-pick revert', {
      abbreviations: true,
      effects: hooks,
      options: opts(
        '-n --no-commit',
        '-e --edit',
        '-m= --mainline=',
        '--continue',
        '--abort',
        '--skip',
        '--quit',
        '-x',
        '-s= --strategy=',
        '-X= --strategy-option=',
        '-S=? --gpg-sign=?',
      ),
      finish: finishStrategy,
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
        list: {},
        show: { abbreviations: true, options: opts(o('--output=', { role: 'write' })) },
        // `export --to-ref` sets a ref to the stashes, whatever it held, as `recommended` asks about.
        export: {
          abbreviations: true,
          effects: ['fs:write'],
          options: opts('--print', '--to-ref='),
        },
        import: { effects: ['fs:write'] },
      },
    },
    remote: {
      options: opts('-v --verbose'),
      subcommands: {
        ...each('add remove|rm rename set-url set-head set-branches', { effects: ['fs:write'], finish: finishRemoteEdit }),
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
        '--bool-or-int',
        '--path',
        '--expiry-date',
        '--comment=',
        '--default=',
        '--value=',
        o('--blob=', { role: 'read' }),
        '--url=',
        '--fixed-value',
        '--all',
        '--append',
        '--regexp',
        '--get-urlmatch',
        '--get-color',
        '--get-colorbool',
        '--show-origin',
        '--show-scope',
        '--name-only',
        '-z --null',
        '--includes',
        '--no-includes',
        o('-e --edit', { effects: ['exec:arbitrary'] }),
      ),
      finish: finishConfig,
    },
    rm: {
      abbreviations: true,
      effects: ['fs:delete'],
      positionals: 'delete',
      options: opts('-r', '-f --force', '--cached', '-n --dry-run', '-q --quiet'),
    },
    mv: {
      abbreviations: true,
      effects: ['fs:write'],
      options: opts('-f --force', '-k', '-n --dry-run', '-v --verbose'),
      finish: finishGitMove,
    },
    ...each('apply am', { abbreviations: true, effects: hooks }),
    submodule: { effects: ['network', ...hooks] },
    worktree: {
      subcommands: {
        list: { options: opts('--porcelain', '-v --verbose', '--expire=', '-z') },
        // A new work tree is checked out where it says, which runs post-checkout.
        add: { effects: ['fs:write', ...hooks], positionals: 'write' },
        ...each('remove prune', { effects: ['fs:delete'] }),
        ...each('move lock unlock repair', { effects: ['fs:write'] }),
      },
    },
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
  if (!ghReads.has(parsed.subcommands.join(' ')) || ghGoesElsewhere(parsed)) return;
  parsed.effects.delete('network');
  parsed.effects.add('network:read');
}

/** gh's commands that only read from GitHub: the host gh is signed in to, or the one the repository's remotes name. */
const ghReads = new Set(
  [
    'pr checks|diff|list|status|view',
    'issue list|status|view',
    'run list|view|watch',
    'workflow list|view',
    'release list|view',
    'repo list|read-dir|read-file|view',
    'search code|commits|issues|prs|repos',
    'label list',
    'cache list',
    'ruleset check|list|view',
    'discussion list|view',
    'project field-list|item-list|list|view',
    'org list',
    'status',
  ].flatMap((line) => {
    const [group, names] = line.split(' ');
    return names ? names.split('|').map((name) => `${group} ${name}`) : [line];
  }),
);

/**
 * Whether a gh command that reads may call a host of the command line's choosing, or open a browser: a URL, a
 * repository given as `HOST/OWNER/REPO` or as a git URL, `--web`, or words the spec isn't sure of.
 */
function ghGoesElsewhere(parsed: Parsed): boolean {
  if (parsed.unknownOptions.length > 0 || parsed.maybeOptions || parsed.options['--web'] !== undefined) return true;
  const repositories = [...(parsed.options['--repo'] ?? []), ...(parsed.subcommands.join(' ') === 'repo view' ? parsed.positionals : [])];
  if (repositories.some((arg) => arg === true || arg.kind === 'dynamic' || !/^[\w.-]+\/[\w.-]+$/.test(arg.value))) return true;
  return parsed.positionals.some((arg) => arg.kind === 'dynamic' || arg.value.includes('://'));
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
  if (options['-F'] || (next?.kind === 'dynamic' && (next.prefix === '' || next.prefix.startsWith('-') || next.split))) {
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
    // A word that may split may hold any part of the expression, wherever it is: a test's value or a command's
    // argument (`-name a$x` or `-exec echo $x` with `x=' ; -delete'`).
    if (args.some((arg) => arg.kind === 'dynamic' && arg.split)) parsed.maybeOptions = true;
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
        // Ended by `{} +`, the last `{}` stands for as many paths as fit.
        const many = staticValue(args[end]) === '+';
        const argv = args.slice(i + 1, end).map((word, j, words): Arg => {
          const text = staticValue(word);
          return text?.includes('{}')
            ? {
                kind: 'dynamic',
                text,
                reason: 'placeholder',
                split: many && j === words.length - 1,
                prefix: text.slice(0, text.indexOf('{}')),
              }
            : word;
        });
        // The command it runs is an invocation of its own, judged on its own; `exec:arbitrary` on the options is
        // only for a dynamic word that may be one of them.
        if (argv.length > 0) parsed.nested.push({ argv, open: false });
        // -execdir runs it in the directory of each file found.
        if (value.endsWith('dir')) parsed.cwd = { kind: 'dynamic', text: '{}', reason: 'placeholder', split: false, prefix: '' };
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

const envSpec: CommandSpec = {
  abbreviations: true,
  posix: true,
  command: { assignments: 'any' },
  options: opts(
    '-i --ignore-environment',
    '-u= --unset=',
    o('-C= --chdir=', { role: 'cwd' }),
    // Split by `splitEnv`: one left here had no value, or nothing to split.
    o('-S= --split-string=', { role: 'argv' }),
    '-0 --null',
    '-v --debug',
    '--block-signal=?',
    '--default-signal=?',
    '--ignore-signal=?',
  ),
  finish(parsed) {
    // A lone `-` right after the options is `-i`: assignments and the command come after it. After an assignment
    // (`env -- --x=1 - cat`), it's the command.
    const [nested] = parsed.nested;
    if (parsed.env.length > 0 || nested?.argv[0]?.kind !== 'static' || nested.argv[0].value !== '-') return;
    const rest = nested.argv.slice(1);
    const command = rest.findIndex((arg) => arg.kind === 'dynamic' || !arg.value.includes('='));
    parsed.env.push(...rest.slice(0, command === -1 ? rest.length : command));
    parsed.nested = command === -1 ? [] : [{ ...nested, argv: rest.slice(command) }];
  },
};

/** A long option of env's, by any unique prefix getopt takes: `--sp` is `--split-string`. */
const envLong = (name: string, full: string) => name.length >= 3 && full.startsWith(name);

/** Whether uutils' env splits another `-S` among the arguments after one, which GNU's may give the command. */
function splitsAgain(rest: Arg[]): boolean {
  for (const arg of rest) {
    const value = staticValue(arg);
    if (value === undefined) return true;
    if (value === '--' || !(value.startsWith('-') || value.includes('='))) return false;
    if (/^-v{0,2}S|^--split-string(?:=|$)/.test(value)) return true;
  }
  return false;
}

/**
 * env's arguments as it reads them: each `-S` string split into words in its place, among env's own arguments, so
 * options, assignments and the command may come from it (`env -S'-i cat a' b` runs `cat a b`). Variables in it
 * (`${HOME}`) are only known at run time.
 *
 * uutils' env splits only `-S`, `-vS`, `-vvS` and `--split-string` as spelled, among the arguments it hasn't stopped
 * at (the value of an abbreviated long option stops it), and not again in what it split; clap reads any other and
 * ignores it. `uutils.differs` says one of those came up, and then what runs depends on which env it is.
 */
function splitEnv(args: Arg[], uutils: { differs: boolean }, nested = false): Arg[] {
  let stopped = false;
  for (let i = 0; i < args.length; i++) {
    const value = staticValue(args[i]);
    if (value === undefined || value === '--' || !isOption(value)) return args;
    let string: Arg | undefined;
    let used = 1;
    const long = /^(--[^=]+)(?:=([\s\S]*))?$/.exec(value);
    if (long) {
      const [, name = '', attached] = long;
      if (!envLong(name, '--split-string')) {
        if (attached !== undefined || !(envLong(name, '--unset') || envLong(name, '--chdir'))) continue;
        const next = staticValue(args[i + 1]);
        if (name !== '--unset' && name !== '--chdir' && !(next !== undefined && (next.startsWith('-') || next.includes('='))))
          stopped = true;
        i++;
        continue;
      }
      if (name !== '--split-string') uutils.differs = true;
      string = attached === undefined ? args[i + 1] : { kind: 'static', value: attached };
      used = attached === undefined ? 2 : 1;
    } else {
      // Letters up to S, or one that takes the rest as its value (`-uS` unsets S).
      const at = value.split('').findIndex((letter, j) => j > 0 && 'uCS'.includes(letter));
      if (at === -1 || value[at] !== 'S') {
        if (at !== -1 && at === value.length - 1) i++;
        continue;
      }
      if (at > 1 && value.slice(0, at) !== '-v' && value.slice(0, at) !== '-vv') uutils.differs = true;
      const rest = value.slice(at + 1);
      string = rest ? { kind: 'static', value: rest } : args[i + 1];
      used = rest ? 1 : 2;
      if (at > 1) args = [...args.slice(0, i), { kind: 'static', value: value.slice(0, at) }, ...args.slice(i)];
      if (at > 1) i++;
    }
    if (!string) return args;
    if (stopped || nested || splitsAgain(args.slice(i + used))) uutils.differs = true;
    const lookup = () => ({ kind: 'dynamic' as const });
    // A backslash is env's own escape, none of them the shell's (`\_` separates words, `\c` ends them). env also splits
    // at \v, \f and \r, where the shell doesn't, and expands no braces.
    const words = string.kind === 'static' && !/[\\\v\f\r{}]/.test(string.value) ? resolveWords(string.value, lookup) : undefined;
    const split = words ?? [dynamicArg(string.kind === 'static' ? string.value : string.text, 'variable', true, '')];
    return [...args.slice(0, i), ...splitEnv([...split, ...args.slice(i + used)], uutils, true)];
  }
  return args;
}

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
    '--no-preserve=',
    '--sparse=',
    '--reflink=?',
    '-l --link',
    '-s --symbolic-link',
    '-d',
    '-P --no-dereference',
    '-L --dereference',
    '-H',
    '-x --one-file-system',
    '--parents',
    '--attributes-only',
    '--strip-trailing-slashes',
    '--remove-destination',
    '--copy-contents',
    '--debug',
    '--keep-directory-symlink',
    '--exchange',
    '--no-copy',
    '-Z',
    '--context=?',
  ),
  finish(parsed) {
    // An option it doesn't know may have taken the next word, so any of them may be the target.
    if (parsed.unknownOptions.length > 0) parsed.writes.push(...parsed.positionals);
    const directories = parsed.options['--target-directory']?.filter((value) => value !== true) ?? [];
    const targets = directories.length > 0 ? [] : parsed.positionals.slice(-1);
    const sources = directories.length > 0 ? parsed.positionals : parsed.positionals.slice(0, -1);
    // A hard link (`cp -l`) is the source itself, and a symbolic one (`-s`) leads to it: what's later written to the
    // copy is written to it. So is what a symlink copied as one (`-P`, `-d`, `-a`, or `-r` without `-L`) leads to.
    const links = ['--link', '--symbolic-link', '--no-dereference', '-d', '--archive'].some((name) => parsed.options[name]);
    const keeps = links || (parsed.options['--recursive'] && !parsed.options['--dereference']);
    parsed.writes.push(...targets, ...(all || keeps ? sources : []));
    parsed.reads.push(...sources);
    // Into a directory, each source lands under its own name (`cp -r x/.git .` writes `./.git`), and a directory's
    // contents (`x/.`) under names only known at run time.
    // With -T, the target is the copy: a directory's contents land in it under names only known at run time.
    if (parsed.options['--no-target-directory']) {
      for (const target of targets) {
        const base = staticValue(target)?.replace(/\/+$/, '');
        parsed.writes.push(dynamicArg(`${base ?? '…'}/…`, 'placeholder', false, base === undefined ? '' : `${base}/`));
      }
      return;
    }
    for (const directory of [...directories, ...targets]) {
      const into = staticValue(directory);
      for (const source of sources) {
        // --parents puts each under its whole path as given: `d/../../x` is outside `d`.
        if (parsed.options['--parents']) {
          const path = staticValue(source);
          parsed.writes.push(
            into !== undefined && path !== undefined
              ? { kind: 'static', value: `${into.replace(/\/+$/, '')}/${path}` }
              : dynamicArg(`${into ?? '…'}/…`, 'placeholder', false, ''),
          );
          continue;
        }
        const name = staticValue(source)?.replace(/\/+$/, '').split('/').pop();
        const base = into?.replace(/\/+$/, '');
        const known = base !== undefined && name !== undefined && name !== '' && name !== '.' && name !== '..';
        parsed.writes.push(
          known
            ? { kind: 'static', value: `${base}/${name}` }
            : dynamicArg(`${into ?? '…'}/…`, 'placeholder', false, base === undefined ? '' : `${base}/`),
        );
      }
    }
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

/** What a sed script does besides editing what it reads. */
interface SedScript {
  /** Whether `e`, or the `e` flag of `s`, runs a command. */
  runs: boolean;
  reads: string[];
  writes: string[];
}

/**
 * Reads a sed script command by command, or returns `undefined` where it can't say how sed would. Seds differ on a
 * delimiter inside a bracket expression (GNU sed 4.9 carries on, older ones end the text there), on where a file name
 * or a label ends, and on the text of `a`, `i` and `c`: those aren't followed.
 */
function scanSed(script: string): SedScript | undefined {
  const found: SedScript = { runs: false, reads: [], writes: [] };
  let i = 0;
  const blanks = () => {
    while (script[i] === ' ' || script[i] === '\t') i++;
  };
  const digits = () => {
    const start = i;
    while (/[0-9]/.test(script[i] ?? '')) i++;
    return i > start;
  };
  /** The rest of the line: a file name, or the command `e` runs. */
  const line = () => {
    blanks();
    const start = i;
    const end = script.indexOf('\n', i);
    i = end === -1 ? script.length : end;
    return script.slice(start, i);
  };
  /** Whether the command ends here: nothing more, a newline, `;`, `}` or a comment. */
  const ends = () => {
    blanks();
    return i >= script.length || '\n;}#'.includes(script[i]!);
  };
  /** A file name every sed ends at the same place: BusyBox stops at a blank or a `;`. */
  const file = (files: string[]) => {
    const name = line();
    if (name === '' || /[\s;}]/.test(name)) return false;
    files.push(name);
    return true;
  };
  const delimiter = () => {
    const c = script[i];
    if (c === undefined || !/^[ -Z^-~]$/.test(c)) return undefined;
    i++;
    return c;
  };
  /** A bracket expression, up to its `]`, with nothing in it that seds read differently. */
  const bracket = (closing: string) => {
    i++;
    if (script[i] === '^' && closing !== '^') i++;
    if (script[i] === ']') i++;
    for (; i < script.length; i++) {
      const c = script[i]!;
      if (c === ']') return true;
      if (c === closing || c === '\n') return false;
      if (c === '\\' && /^[[\]\n]?$/.test(script[++i] ?? '')) return false;
      if (c !== '[') continue;
      if (script[i + 1] === '.' || script[i + 1] === '=') return false;
      if (script[i + 1] !== ':') continue;
      const end = script.indexOf(':]', i + 2);
      if (end === -1 || script.slice(i, end + 2).includes(closing)) return false;
      i = end + 1;
    }
    return false;
  };
  /** Past the next `closing` that isn't escaped. */
  const until = (closing: string, regex: boolean) => {
    for (; i < script.length; i++) {
      const c = script[i]!;
      if (c === '\n') return false;
      if (c === closing) {
        i++;
        return true;
      }
      if (c === '\\' && /^\n?$/.test(script[++i] ?? '')) return false;
      if (regex && c === '[' && !bracket(closing)) return false;
    }
    return false;
  };
  const address = () => {
    if (script[i] === '$') {
      i++;
      return true;
    }
    if (script[i] === '/' || script[i] === '\\') {
      if (script[i] === '\\') i++;
      const closing = delimiter();
      if (closing === undefined || !until(closing, true)) return false;
      while (script[i] === 'I' || script[i] === 'M') i++;
      return true;
    }
    if (!digits()) return false;
    if (script[i] !== '~') return true;
    i++;
    return digits();
  };
  const addressed = () => /^[0-9$/\\]$/.test(script[i] ?? '');
  const command = () => {
    if (addressed()) {
      if (!address()) return false;
      blanks();
      if (script[i] === ',') {
        i++;
        blanks();
        if (script[i] === '+' || script[i] === '~') {
          i++;
          if (!digits()) return false;
        } else if (!addressed() || !address()) {
          return false;
        }
        blanks();
      }
    }
    while (script[i] === '!') {
      i++;
      blanks();
    }
    const name = script[i++] ?? '';
    if (name === '{') return true;
    if (name !== '' && '=dDgGhHnNpPxzF'.includes(name)) return ends();
    if (name !== '' && 'lLqQ'.includes(name)) {
      blanks();
      digits();
      return ends();
    }
    if (name !== '' && ':btT'.includes(name)) {
      blanks();
      while (/\w/.test(script[i] ?? '')) i++;
      return ends();
    }
    if (name === 'r' || name === 'R') return file(found.reads);
    if (name === 'w' || name === 'W') return file(found.writes);
    if (name === 'e') {
      found.runs = true;
      line();
      return true;
    }
    if (name === 'y') {
      const closing = delimiter();
      return closing !== undefined && until(closing, false) && until(closing, false) && ends();
    }
    if (name !== 's') return false;
    const closing = delimiter();
    if (closing === undefined || !until(closing, true) || !until(closing, false)) return false;
    for (;;) {
      if (ends()) return true;
      const flag = script[i++]!;
      if (flag === 'w') return file(found.writes);
      if (flag === 'e') found.runs = true;
      else if (!'gpiImM0123456789'.includes(flag)) return false;
    }
  };
  while (i < script.length) {
    if (' \t\n;}'.includes(script[i]!)) i++;
    else if (script[i] === '#') line();
    else if (!command()) return undefined;
  }
  return found;
}

/**
 * An awk program's effects, by the tokens it can't have them without: `system`, a pipe and `getline` run commands or
 * read files the program names, `@` calls a function named at run time or loads code, and a `>` after a `print`
 * writes a file. The text is searched as written, strings and regular expressions included, so it finds more than is
 * there and never less. A line continuation could split a token, so one counts as code unseen.
 */
function scanAwk(code: string, parsed: Parsed): void {
  if (/system|getline|@|\\\r?\n/.test(code) || code.replaceAll('||', '').includes('|')) parsed.effects.add('exec:arbitrary');
  const print = code.indexOf('print');
  if (print === -1 || !/>(?!=)/.test(code.slice(print))) return;
  parsed.writes.push(dynamicArg('awk output', 'variable', false, ''));
  parsed.effects.add('fs:write');
}

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
    abbreviations: true,
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
    abbreviations: true,
    effects: ['privilege'],
    options: opts(o('-c= --command=', { role: 'script' }), '-l --login', '-s= --shell=', '-m -p --preserve-environment', '-g= --group='),
  },
  env: {
    ...envSpec,
    parse(args, parsed) {
      const uutils = { differs: false };
      Object.assign(parsed, normalize(splitEnv(args, uutils), envSpec));
      if (uutils.differs) parsed.nested = [{ argv: [anyWords], open: true }];
    },
  },
  nice: {
    posix: true,
    abbreviations: true,
    command: {},
    options: opts('-n= --adjustment='),
    finish(parsed) {
      // uutils' nice rewrites `-n N`, `--adj N` and `-N` into `-nN` up to the first word without a dash, `--` too:
      // `nice -- -n 1 cmd` runs `-n` in GNU's, `-n1` in uutils'.
      const [nested] = parsed.nested;
      const first = nested?.argv[0];
      if (!first || !(first.kind === 'static' ? first.value : first.prefix).startsWith('-')) return;
      nested.argv = [anyWords, ...nested.argv];
    },
  },
  nohup: { posix: true, abbreviations: true, command: {} },
  timeout: {
    abbreviations: true,
    posix: true,
    command: { skip: 1 },
    options: opts('-s= --signal=', '-k= --kill-after=', '--preserve-status', '--foreground', '-v --verbose'),
  },
  stdbuf: { posix: true, abbreviations: true, command: {}, options: opts('-i= --input=', '-o= --output=', '-e= --error=') },
  time: {
    abbreviations: true,
    posix: true,
    command: {},
    options: opts(o('-o= --output=', { role: 'write' }), '-f= --format=', '-a --append', '-p --portability', '-v --verbose', '-q --quiet'),
  },
  chroot: {
    posix: true,
    abbreviations: true,
    effects: ['privilege'],
    command: { skip: 1 },
    options: opts('--userspec=', '--groups=', '--skip-chdir'),
    finish: shellWithout,
  },
  xargs: {
    abbreviations: true,
    posix: true,
    command: { open: true, fallback: 'echo' },
    options: opts(
      '-0 --null',
      o('-a= --arg-file=', { role: 'read' }),
      '-d= --delimiter=',
      '-E=',
      '-e=? --eof=?',
      '-I=',
      '-i=? --replace=?',
      '-L=',
      '-l=? --max-lines=?',
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
    finish(parsed) {
      // With -I R (or -i, whose R is `{}`), each line of input takes R's place in any word of the command, its name too.
      const known = [
        ...(parsed.options['-I'] ?? []).map((value) => (value === true ? undefined : staticValue(value))),
        ...(parsed.options['--replace'] ?? []).map((value) => (value === true ? '{}' : staticValue(value))),
      ];
      if (known.length === 0) return;
      for (const nested of parsed.nested) {
        nested.argv = nested.argv.map((arg) => {
          const text = arg.kind === 'static' ? arg.value : arg.text;
          const at = known.some((value) => value === undefined)
            ? 0
            : Math.min(...known.map((value) => text.indexOf(value!)).filter((i) => i >= 0));
          if (!Number.isFinite(at)) return arg;
          const prefix = arg.kind === 'static' ? arg.value.slice(0, at) : arg.prefix.slice(0, at);
          return dynamicArg(text, 'stdin', false, prefix);
        });
      }
    },
  },
  watch: {
    abbreviations: true,
    posix: true,
    options: opts(
      '-n= --interval=',
      '-d=? --differences=?',
      '-t --no-title',
      '-b --beep',
      '-e --errexit',
      '-g --chgexit',
      '-c --color',
      '-x --exec',
      '-p --precise',
      '-w --no-wrap',
      '-q= --equexit=',
      o('-s= --shotsdir=', { role: 'write' }),
      '-f --follow',
      '-C --no-color',
      '-r --no-rerun',
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
  setsid: { posix: true, abbreviations: true, command: {}, options: opts('-w --wait', '-f --fork', '-c --ctty') },
  strace: {
    abbreviations: true,
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
    abbreviations: true,
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
    finish: shellWithout,
  },
  ionice: {
    posix: true,
    abbreviations: true,
    command: {},
    options: opts('-c= --class=', '-n= --classdata=', '-p= --pid=', '-P= --pgid=', '-u= --uid='),
  },
  // `chrt -p` and `taskset -p` change a running process: there's no command. `taskset -c` reads the mask as a list; it's still a positional.
  chrt: {
    abbreviations: true,
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
  taskset: {
    posix: true,
    abbreviations: true,
    command: { skip: 1 },
    options: opts('-c --cpu-list', '-p --pid', '-a --all-tasks'),
    finish: noCommandWithPid,
  },
  flock: {
    abbreviations: true,
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
      if (first?.kind === 'static' && (first.value === '-c' || first.value === '--command')) {
        parsed.nested = [];
        if (nested!.argv[1]) parsed.scripts.push(nested!.argv[1]);
      }
      // With a command to run, the positional is a lock file, created when missing. Alone, it's a descriptor.
      const lock = parsed.positionals[0];
      if (!lock || (nested === undefined && parsed.scripts.length === 0)) return;
      parsed.writes.push(lock);
      parsed.effects.add('fs:write');
    },
  },
  script: {
    abbreviations: true,
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
    options: opts(
      o('--prefix= -C=', { role: 'cwd' }),
      '-w= --workspace=',
      '--workspaces',
      '--include-workspace-root',
      '-g --global',
      '-s --silent',
      '-q --quiet',
      '-d --loglevel=',
      '-y --yes',
      '--if-present',
      '--ignore-scripts',
      '--foreground-scripts',
      '--json',
      '-p --parseable',
      '-l --long',
      '-a --all',
      '--depth=',
      '--omit=',
      '--include=',
      '-D --save-dev',
      '-P --save-prod',
      '-E --save-exact',
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      '--offline',
      '--dry-run',
      '-v --version',
      '-h --help',
    ),
    subcommands: {
      ...each('run|run-script|rum|urn test|t|tst start stop restart', { effects: ['exec:project'] }),
      ...each(
        'install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add ci|clean-install|ic|install-clean|isntall-clean update|up|upgrade|udpate rebuild|rb uninstall|unlink|remove|rm|r|un install-test|it install-ci-test|cit dedupe|ddp prune find-dupes link|ln',
        { effects: ['network', 'fs:write', 'exec:project'] },
      ),
      ...each('exec|x init|create|innit edit explore', { effects: ['network', 'exec:arbitrary'] }),
      ...each(
        'publish unpublish deprecate dist-tag|dist-tags owner|author access team login logout adduser|add-user audit outdated view|info|show|v search|find|s|se doctor docs|home bugs|issues repo fund diff hook token profile org star stars unstar ping whoami',
        { effects: ['network'] },
      ),
      // `npm version` runs the version scripts, and commits and tags with git.
      'version|verison': { effects: ['exec:project'], finish: writesManifest },
      pack: { effects: ['exec:project', 'fs:write'], finish: packsElsewhere },
      shrinkwrap: { effects: ['fs:write'] },
      cache: { effects: ['fs:write', 'fs:delete'] },
      'config|c': { finish: setsConfig },
      set: { effects: ['exec:arbitrary'] },
      pkg: {
        finish(parsed) {
          if (staticValue(parsed.positionals[0]) !== 'get') writesManifest(parsed);
        },
      },
      ...each('ls|list ll|la get prefix root bin help|hlep explain|why query sbom completion', {}),
    },
    finish(parsed) {
      // npm takes any unique start of a command's name (`npm exe` is `npm exec`), and reads an option it doesn't
      // know as configuration, which may name the shell its scripts run in.
      if (parsed.subcommands.length === 0 && parsed.unknownSubcommand) parsed.effects.add('exec:arbitrary');
      unknownIsConfig(parsed);
    },
  },
  npx: {
    posix: true,
    effects: ['network', 'exec:arbitrary'],
    options: opts('-p= --package=', o('-c= --call=', { role: 'script' }), '-y --yes', '--no'),
  },
  pnpm: {
    posix: true,
    options: pnpmOptions,
    subcommands: {
      // pnpm's own options come before the script's name; every word after it is the script's.
      'run|run-script': { posix: true, options: pnpmOptions, effects: ['exec:project'] },
      ...each('test|t|tst start restart stop', { verbatim: true, effects: ['exec:project'] }),
      exec: {
        posix: true,
        options: [...pnpmOptions, o('-c --shell-mode', { effects: ['exec:arbitrary'] })],
        command: {},
        effects: ['exec:project'],
      },
      // `pnpm with <version> …` runs another pnpm.
      ...each('dlx|x create with', { posix: true, effects: ['network', 'exec:arbitrary'] }),
      ...each(
        'install|i add update|up|upgrade remove|rm|uninstall|un link|ln unlink import rebuild|rb fetch install-test|it ci query dedupe prune deploy patch patch-commit patch-remove approve-builds env runtime|rt setup self-update clean',
        { effects: ['network', 'fs:write', 'exec:project'] },
      ),
      ...each(
        'audit outdated licenses view|info|show|v search|find|s|se publish stage login|adduser|add-user logout whoami doctor docs|home bugs|issues repo dist-tag|dist-tags owner|author access team unpublish deprecate token profile org star stars unstar ping sbom store cache',
        { effects: ['network'] },
      ),
      ...each('edit recursive|multi|m', { effects: ['exec:arbitrary'] }),
      'version|verison': { effects: ['exec:project'], finish: writesManifest },
      pack: { effects: ['exec:project', 'fs:write'], finish: packsElsewhere },
      init: { finish: writesManifest },
      'config|c': { finish: setsConfig },
      set: { effects: ['exec:arbitrary'] },
      pkg: {
        finish(parsed) {
          if (staticValue(parsed.positionals[0]) !== 'get') writesManifest(parsed);
        },
      },
      ...each('ls|list ll|la why root bin help get ignored-builds cat-file cat-index find-hash completion', {}),
    },
    finish(parsed) {
      unknownIsConfig(parsed);
      // A word pnpm doesn't know is a script, or else a command it runs from PATH (`pnpm node -e …`).
      if (parsed.subcommands.length > 0 || !parsed.unknownSubcommand) return;
      runsScript(parsed, parsed.unknownSubcommand, true);
    },
  },
  bun: {
    posix: true,
    options: bunOptions,
    subcommands: {
      // `bun run` runs a script, else a file, else a command from PATH (`bun run echo hi`).
      run: {
        posix: true,
        options: bunOptions,
        finish(parsed) {
          if (parsed.positionals[0]) runsScript(parsed, parsed.positionals[0], true);
        },
      },
      test: {
        options: [
          ...bunOptions,
          ...opts(
            '--timeout=',
            '-u --update-snapshots',
            '--rerun-each=',
            '--retry=',
            '--todo',
            '--only',
            '--pass-with-no-tests',
            '--concurrent',
            '--randomize',
            '--seed=',
            '--coverage',
            '--coverage-reporter=',
            o('--coverage-dir=', { role: 'write' }),
            '--bail=?',
            '-t= --test-name-pattern=',
            '--reporter=',
            o('--reporter-outfile=', { role: 'write' }),
            '--dots',
            '--only-failures',
            '--max-concurrency=',
            '--path-ignore-patterns=',
            '--changed=?',
            '--isolate',
            '--no-isolate',
            '--parallel-delay=',
            '--shard=',
            '--timings=?',
            '--update-timings',
          ),
        ],
        effects: ['exec:project'],
        // A word that's a path is a test file it runs; any other filters the project's.
        finish(parsed) {
          loadsFrom(
            parsed,
            parsed.positionals.filter((arg) => arg.kind !== 'static' || /^[.~]|\//.test(arg.value)),
          );
        },
      },
      // A script of the same name runs in place of these.
      check: {
        options: opts(
          '-p= --project=',
          '--pretty=?',
          '--no-pretty',
          '-b --build',
          '--all',
          '--threads=',
          '--timing',
          o('--cwd=', { role: 'cwd' }),
          '--no-script',
          '--strict',
          '--target=',
          '-h --help',
        ),
        effects: ['exec:project'],
      },
      fmt: {
        options: opts(
          '-c --check',
          '--staged',
          '--changed=?',
          '--stdin-filepath=',
          '--print-width=',
          '--use-tabs',
          '--no-semi',
          '--single-quote',
          '--init',
          '--doctor',
          '--no-script',
          '-h --help',
        ),
        effects: ['exec:project', 'fs:write'],
      },
      'build|bun': {
        // `-e` is --external here, ahead of the runtime's --eval.
        options: [
          ...opts(
            o('--outdir=', { role: 'write' }),
            o('--outfile=', { role: 'write' }),
            o('--metafile= --metafile-md=', { role: 'write' }),
            '--production',
            '--compile',
            '--compile-exec-argv=',
            '--bytecode-order=',
            '--compile-jit-policy=',
            '--compile-autoload-dotenv',
            '--no-compile-autoload-dotenv',
            '--compile-autoload-bunfig',
            '--no-compile-autoload-bunfig',
            '--compile-autoload-tsconfig',
            '--no-compile-autoload-tsconfig',
            '--compile-autoload-package-json',
            '--no-compile-autoload-package-json',
            o('--compile-executable-path=', { role: 'read' }),
            '--asset=',
            '--bytecode',
            '--bytecode-depth=',
            '--no-optimize-bytecode',
            '--target=',
            '--sourcemap=?',
            '--banner=',
            '--footer=',
            '--format=',
            '--root=',
            '--splitting',
            '--no-split-require',
            '--no-module-preload',
            '--min-chunk-size=',
            '--public-path=',
            '-e= --external=',
            '--allow-unresolved=',
            '--reject-unresolved',
            '--packages=',
            '--entry-naming=',
            '--chunk-naming=',
            '--asset-naming=',
            '--react-fast-refresh',
            '--react-compiler',
            '--no-bundle',
            '--emit-dce-annotations',
            '--no-deprecated-namespace-object-setters',
            '--minify',
            '--minify-syntax',
            '--minify-whitespace',
            '--minify-identifiers',
            '--keep-names',
            '--css-chunking',
            '--app',
            '--env=',
            '--windows-hide-console',
            '--windows-icon=',
            '--windows-title=',
            '--windows-publisher=',
            '--windows-version=',
            '--windows-description=',
            '--windows-copyright=',
          ),
          ...bunOptions,
        ],
        effects: ['exec:project'],
        // It runs the macros its entry points import.
        finish(parsed) {
          loadsFrom(parsed, parsed.positionals);
        },
      },
      'x|bunx': { posix: true, effects: ['network', 'exec:arbitrary'] },
      ...each('repl exec', { effects: ['exec:arbitrary'] }),
      ...each('create|c', { effects: ['network', 'exec:arbitrary'] }),
      ...each('install|i|ci add|a remove|rm|r|uninstall update link unlink patch patch-commit pm init dedupe prune upgrade completions', {
        effects: ['network', 'fs:write', 'exec:project'],
      }),
      ...each('audit outdated info why publish whoami login logout discord feedback', { effects: ['network'] }),
      ...each('help deploy list getcompletes', {}),
    },
    finish(parsed) {
      unknownIsConfig(parsed);
      // With no node_modules, bun installs what the code it runs imports, from the registry the project names.
      const verb = parsed.subcommands[0];
      const runs = verb === undefined ? parsed.unknownSubcommand !== undefined : verb === 'run' || verb === 'test';
      if (runs && !flag(parsed, '--no-install')) parsed.effects.add('network:read');
      // A word bun doesn't know is a script, or else a file: `bun f` runs `f.ts`.
      if (parsed.subcommands.length > 0 || !parsed.unknownSubcommand) return;
      runsScript(parsed, parsed.unknownSubcommand, false);
    },
  },
  cargo: {
    // Every command reads the project's `.cargo/config.toml`, whose aliases and `rustc-wrapper` run code, and those
    // that build run its build scripts and macros.
    effects: ['exec:project'],
    options: cargoOptions,
    subcommands: {
      ...each(
        'build|b check|c run|r doc|d clippy metadata tree pkgid locate-project verify-project read-manifest report config version help generate-lockfile',
        { options: cargoOptions },
      ),
      fix: { options: cargoOptions, effects: ['fs:write'] },
      // The words after `--` go to rustfmt: files it rewrites in place, wherever they are.
      fmt: { options: cargoOptions, effects: ['fs:write'], finish: (parsed) => parsed.writes.push(...parsed.positionals) },
      clean: { options: cargoOptions, effects: ['fs:delete'] },
      // The words after `--` go to the test harness, whose `--logfile` it writes.
      ...each('test|t bench', {
        options: cargoOptions,
        finish: (parsed) => {
          if (!parsed.separated) return;
          parsed.positionals.forEach((arg, i) => {
            const text = arg.kind === 'static' ? arg.value : arg.prefix;
            if (arg.kind === 'dynamic' && '--logfile'.startsWith(text)) parsed.writes.push(dynamicArg('…', 'placeholder', false, ''));
            if (text.startsWith('--logfile=')) parsed.writes.push(arg.kind === 'static' ? { kind: 'static', value: text.slice(10) } : arg);
            const next = parsed.positionals[i + 1];
            if (arg.kind === 'static' && arg.value === '--logfile' && next) parsed.writes.push(next);
          });
          if (parsed.writes.length > 0) parsed.effects.add('fs:write');
        },
      }),
      // The words after `--` go to rustc or rustdoc: a linker (`-C linker=`), an output file, plugins.
      ...each('rustc rustdoc', {
        options: cargoOptions,
        finish: (parsed) => {
          if (parsed.positionals.length > 0 || parsed.maybeOptions) parsed.effects.add('exec:arbitrary');
        },
      }),
      ...each('new init', { options: cargoNew, effects: ['fs:write'], positionals: 'write' }),
      ...each('add remove|rm update fetch vendor package', { options: cargoOptions, effects: ['network', 'fs:write'] }),
      ...each('search info publish login logout owner yank', { options: cargoOptions, effects: ['network'] }),
      ...each('install uninstall', { options: cargoOptions, effects: ['network', 'fs:write', 'exec:arbitrary'] }),
    },
    finish(parsed) {
      // What builds fetches the dependencies it hasn't got, from the registries and git hosts the project names.
      const fetches = /^(build|check|test|run|bench|doc|rustc|rustdoc|clippy|metadata|tree|fix|generate-lockfile)$/;
      if (fetches.test(parsed.subcommands[0] ?? '') && !flag(parsed, '--offline') && !flag(parsed, '--frozen'))
        parsed.effects.add('network:read');
      // A word cargo doesn't know is an alias, or the program `cargo-<word>` on PATH; `+toolchain` is rustup's.
      if (parsed.subcommands.length === 0 && parsed.unknownSubcommand) parsed.effects.add('exec:arbitrary');
    },
  },
  // TypeScript 7, native: its configuration is JSON, and it writes only what it emits.
  'tsc|tsgo': {
    edits: tscEmits,
    options: opts(
      '-b --build',
      '-w --watch',
      o('-p= --project=', { role: 'read' }),
      '--noEmit',
      '--listFilesOnly',
      '--showConfig',
      '--init',
      '--clean',
      o('--outDir=', { role: 'write' }),
      o('--outFile=', { role: 'write' }),
      o('--declarationDir=', { role: 'write' }),
      o('--tsBuildInfoFile=', { role: 'write' }),
      o('--generateTrace=', { role: 'write' }),
      o('--generateCpuProfile=', { role: 'write' }),
      o('--pprofDir=', { role: 'write' }),
      '-t= --target=',
      '-m= --module=',
      '--moduleResolution=',
      '--moduleDetection=',
      '--moduleSuffixes=',
      '--lib=',
      '--jsx=',
      '--jsxFactory=',
      '--jsxFragmentFactory=',
      '--jsxImportSource=',
      '--reactNamespace=',
      '--rootDir=',
      '--rootDirs=',
      '--baseUrl=',
      '--types=',
      '--typeRoots=',
      '--customConditions=',
      '--locale=',
      '--newLine=',
      '--mapRoot=',
      '--sourceRoot=',
      '--maxNodeModuleJsDepth=',
      '--checkers=',
      '--builders=',
      '--watchFile=',
      '--watchDirectory=',
      '--watchInterval=',
      '--fallbackPolling=',
      '--excludeDirectories=',
      '--excludeFiles=',
      '-h --help',
      '-v --version',
    ),
    finish(parsed) {
      if (given(parsed, '--init')) {
        writesFile(parsed, 'tsconfig.json');
        return;
      }
      if (given(parsed, '--noEmit', '--listFilesOnly', '--showConfig', '--help', '--version')) return;
      parsed.effects.add(given(parsed, '--clean') ? 'fs:delete' : 'fs:write');
      // It emits beside the sources it's given, and into the project -p names.
      parsed.writes.push(...parsed.positionals, ...parsed.reads);
      const into = ['--outDir', '--declarationDir'].flatMap((name) => parsed.options[name] ?? []).filter((value) => value !== true);
      // tsc reads option names in any case: `--OUTFILE` may take the next word, or any, as the file it writes.
      const outputs = /^--(outdir|outfile|declarationdir|tsbuildinfofile|generatetrace|generatecpuprofile|pprofdir)$/i;
      const unknown = parsed.unknownOptions.some((name) => outputs.test(name));
      (parsed.edited ??= []).push(...(unknown ? [] : parsed.positionals), ...parsed.reads, ...into);
      if (!unknown) return;
      const values = parsed.unknownOptions.flatMap((name) => parsed.options[name] ?? []);
      parsed.writes.push(...values.filter((value) => value !== true));
    },
  },
  biome: {
    edits: biomeEdits,
    options: biomeOptions,
    subcommands: {
      ...each('check lint', {
        options: biomeOptions,
        finish: (parsed) => rewrites(parsed, given(parsed, '--write', '--fix', '--apply', '--apply-unsafe'), false),
      }),
      ...each('format migrate', { options: biomeOptions, finish: (parsed) => rewrites(parsed, given(parsed, '--write', '--fix'), false) }),
      init: { options: opts('--jsonc'), finish: (parsed) => writesFile(parsed, given(parsed, '--jsonc') ? 'biome.jsonc' : 'biome.json') },
      clean: { effects: ['fs:delete'] },
      ...each('ci explain rage search version help lsp-proxy start stop', { options: biomeOptions }),
    },
  },
  // These load JavaScript configuration or plugins: project code, which may write anything. Where they rewrite files
  // in place, the paths they're given are writes too. A configuration file named on the command line, or a plugin given
  // by its path, is code from wherever it is.
  oxlint: {
    effects: ['exec:project'],
    options: opts(
      o('-c= --config=', { role: 'read' }),
      o('--tsconfig=', { role: 'read' }),
      '--init',
      '-A= --allow=',
      '-W= --warn=',
      '-D= --deny=',
      '--fix',
      '--fix-suggestions',
      '--fix-dangerously',
      '--ignore-path=',
      '--ignore-pattern=',
      '--no-ignore',
      '--quiet',
      '--deny-warnings',
      '--max-warnings=',
      '-f= --format=',
      '--debug=',
      '--silent',
      '--no-error-on-unmatched-pattern',
      '--threads=',
      '--print-config',
      '--report-unused-disable-directives',
      '--report-unused-disable-directives-severity=',
      '--rules',
      '--disable-nested-config',
      '--type-aware',
      '--type-check',
      '--disable-unicorn-plugin',
      '--disable-oxc-plugin',
      '--disable-typescript-plugin',
      '--import-plugin',
      '--react-plugin',
      '--jsdoc-plugin',
      '--jest-plugin',
      '--vitest-plugin',
      '--jsx-a11y-plugin',
      '--nextjs-plugin',
      '--react-perf-plugin',
      '--promise-plugin',
      '--node-plugin',
      '--vue-plugin',
      o('--lsp', { effects: ['exec:arbitrary'] }),
      '-h --help',
      '-V --version',
    ),
    finish(parsed) {
      if (given(parsed, '--init')) writesFile(parsed, '.oxlintrc.json');
      // Its configuration may list JavaScript plugins.
      loadsModules(parsed, ['--config'], true);
      unknownIsConfig(parsed);
      loadsFrom(parsed, parsed.positionals);
      rewrites(parsed, given(parsed, '--fix', '--fix-suggestions', '--fix-dangerously'));
    },
  },
  oxfmt: {
    effects: ['exec:project'],
    options: opts(
      o('-c= --config=', { role: 'read' }),
      '--init',
      '--migrate=',
      o('--lsp', { effects: ['exec:arbitrary'] }),
      '--stdin-filepath=',
      '--write',
      '--check',
      '--list-different',
      '--ignore-path=',
      '--disable-nested-config',
      '--with-node-modules',
      '--no-error-on-unmatched-pattern',
      '--threads=',
      '-h --help',
      '-V --version',
    ),
    finish(parsed) {
      // Its configuration may be TypeScript.
      loadsModules(parsed, ['--config'], true);
      unknownIsConfig(parsed);
      loadsFrom(parsed, [...parsed.positionals, ...(parsed.options['--stdin-filepath'] ?? [])]);
      if (given(parsed, '--init', '--migrate')) {
        writesFile(parsed, '.oxfmtrc.json');
        return;
      }
      rewrites(parsed, !given(parsed, '--check', '--list-different', '--lsp', '--stdin-filepath', '--help', '--version'));
    },
  },
  eslint: {
    effects: ['exec:project'],
    options: opts(
      o('-c= --config=', { role: 'read' }),
      '--no-config-lookup',
      // Both fetch and run a package (@eslint/config-inspector, @eslint/create-config).
      o('--inspect-config', { effects: ['network', 'exec:arbitrary'] }),
      o('--init', { effects: ['network', 'exec:arbitrary'] }),
      o('--mcp', { effects: ['exec:arbitrary'] }),
      '--global=',
      '--parser=',
      '--parser-options=',
      '--plugin=',
      '--rule=',
      '--fix',
      '--fix-dry-run',
      '--fix-type=',
      '--no-ignore',
      '--ignore-pattern=',
      '--stdin',
      '--stdin-filename=',
      '--quiet',
      '--max-warnings=',
      o('-o= --output-file=', { role: 'write' }),
      '-f= --format=',
      '--color',
      '--no-color',
      '--no-inline-config',
      '--report-unused-disable-directives',
      '--report-unused-disable-directives-severity=',
      '--report-unused-inline-configs=',
      '--cache',
      o('--cache-file=', { role: 'write' }),
      o('--cache-location=', { role: 'write' }),
      '--cache-strategy=',
      '--env-info',
      '--no-error-on-unmatched-pattern',
      '--exit-on-fatal-error',
      '--no-warn-ignored',
      '--pass-on-no-patterns',
      '--debug',
      '--print-config=',
      '--stats',
      '--flag=',
      '--concurrency=',
      // eslintrc's, before flat configuration.
      '--ext=',
      '--rulesdir=',
      '--resolve-plugins-relative-to=',
      '--env=',
      '--ignore-path=',
      '-h --help',
      '-v --version',
    ),
    finish(parsed) {
      loadsModules(parsed, ['--config', '--rulesdir', '--resolve-plugins-relative-to'], true);
      loadsModules(parsed, ['--plugin', '--parser', '--format']);
      unknownIsConfig(parsed);
      // ESLint 10 finds the configuration beside each file it lints.
      loadsFrom(parsed, [...parsed.positionals, ...(parsed.options['--stdin-filename'] ?? [])]);
      rewrites(parsed, given(parsed, '--fix'));
    },
  },
  prettier: {
    effects: ['exec:project'],
    options: opts(
      '-w --write',
      '-c --check',
      '-l --list-different',
      o('--config=', { role: 'read' }),
      '--no-config',
      '--plugin=',
      '--ignore-path=',
      '--log-level=',
      '--parser=',
      '--stdin-filepath=',
      '--cache',
      o('--cache-location=', { role: 'write' }),
      '--cache-strategy=',
      '--config-precedence=',
      '--no-editorconfig',
      '--find-config-path=',
      '--file-info=',
      '--support-info',
      '--ignore-unknown -u',
      '--no-error-on-unmatched-pattern',
      '--print-width=',
      '--tab-width=',
      '--use-tabs',
      '--no-semi',
      '--single-quote',
      '--jsx-single-quote',
      '--bracket-same-line',
      '--no-bracket-spacing',
      '--end-of-line=',
      '--trailing-comma=',
      '--arrow-parens=',
      '--prose-wrap=',
      '--quote-props=',
      '--html-whitespace-sensitivity=',
      '--embedded-language-formatting=',
      '--object-wrap=',
      '--experimental-operator-position=',
      '--experimental-ternaries',
      '--single-attribute-per-line',
      '--vue-indent-script-and-style',
      '--cursor-offset=',
      '--range-start=',
      '--range-end=',
      '-h --help',
      '-v --version',
    ),
    finish(parsed) {
      loadsModules(parsed, ['--config'], true);
      loadsModules(parsed, ['--plugin']);
      unknownIsConfig(parsed);
      loadsFrom(parsed, [...parsed.positionals, ...(parsed.options['--stdin-filepath'] ?? [])]);
      rewrites(parsed, given(parsed, '--write'));
    },
  },
  // cac and yargs take an option they don't know as configuration, which may load code (`--globalSetup`).
  vitest: {
    effects: ['exec:project'],
    options: vitestOptions,
    subcommands: {
      ...each('run watch dev related bench list', { options: vitestOptions }),
      init: { effects: ['network', 'fs:write', 'exec:arbitrary'] },
    },
    finish(parsed) {
      loadsModules(parsed, ['--root', '--dir', '--config', '--workspace'], true);
      loadsModules(parsed, ['--reporter', '--pool', '--environment', '--diff', '--browser']);
      unknownIsConfig(parsed);
    },
  },
  jest: {
    effects: ['exec:project'],
    options: [...jestOptions, ...opts(...jestModules)],
    finish(parsed) {
      loadsModules(
        parsed,
        jestModules.map((spellings) =>
          spellings
            .split(' ')
            .find((name) => name.startsWith('--'))!
            .replace(/=$/, ''),
        ),
        true,
      );
      unknownIsConfig(parsed);
      // Where it caches and reports coverage, and with --clearCache, a directory it deletes whole.
      for (const name of ['--cacheDirectory', '--coverageDirectory'])
        for (const value of parsed.options[name] ?? []) if (value !== true) parsed.writes.push(value);
      if (parsed.options['--clearCache']) parsed.effects.add('fs:delete');
    },
  },
  tsdown: {
    effects: ['exec:project'],
    options: opts(
      ...camel(
        '-c= --config=',
        '--config-loader=',
        '--no-config',
        '-f= --format=',
        '--clean',
        '--external=',
        '--minify',
        '--debug=?',
        '--target=',
        '-l= --logLevel=',
        '--fail-on-warn',
        '--treeshake',
        '--sourcemap',
        '--shims',
        '--platform=',
        '--dts',
        '--publint',
        '--attw',
        '--unused',
        '-w --watch=?',
        '--ignore-watch=',
        '--from-vite=?',
        '--report',
        '--unbundle',
        '-W --workspace=?',
        '-F= --filter=',
        '--exports',
        '-h --help',
        '-v --version',
      ),
      o('-d= --out-dir=', { role: 'write' }),
      o('--tsconfig=', { role: 'read' }),
      o('--copy=', { role: 'read' }),
      o('--public-dir=', { role: 'read' }),
      // A shell command it runs after each build.
      o('--on-success=', { role: 'script' }),
    ),
    finish(parsed) {
      loadsModules(parsed, ['--config'], true);
      // Each workspace's configuration, from the directories it finds or is given.
      if (parsed.options['--workspace']) parsed.effects.add('exec:file');
      unknownIsConfig(parsed);
    },
  },
  vite: {
    effects: ['exec:project'],
    options: viteServer,
    subcommands: {
      ...each('serve dev', { options: viteServer }),
      build: { options: viteBuild },
      preview: { options: viteServer },
      optimize: { options: opts(...viteCommon, '--force') },
    },
    finish(parsed) {
      loadsModules(parsed, ['--config'], true);
      unknownIsConfig(parsed);
      // Its positional is the project's root, whose configuration it runs.
      for (const root of parsed.positionals) {
        parsed.effects.add('exec:file');
        parsed.reads.push(root);
      }
    },
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
      o('-f= --file=', { role: 'read', effects: ['exec:file'] }),
      o('-i=? --in-place=?', { effects: ['fs:write'] }),
      '-n --quiet --silent',
      '-E --regexp-extended',
      '-r',
      '-s --separate',
      '-u --unbuffered',
      '-z --null-data',
      '-l= --line-length=',
      '--sandbox',
      '--follow-symlinks',
      '--help',
      '--version',
    ),
    finish(parsed) {
      const expressions = parsed.options['--expression'];
      const scripted = expressions !== undefined || parsed.options['--file'] !== undefined;
      const scripts = (expressions ?? (scripted ? [] : parsed.positionals.slice(0, 1))).map((script) =>
        script === true ? undefined : staticValue(script),
      );
      // An option this doesn't know may take the script as its value, and a script only known at run time may be any.
      const known = parsed.unknownOptions.length === 0 && scripts.every((script) => script !== undefined);
      const script = known ? scanSed(scripts.join('\n')) : undefined;
      if (!script || script.runs) parsed.effects.add('exec:arbitrary');
      for (const file of script?.reads ?? []) parsed.reads.push({ kind: 'static', value: file });
      for (const file of script?.writes ?? []) parsed.writes.push({ kind: 'static', value: file });
      if (script && script.writes.length > 0) parsed.effects.add('fs:write');
      const edited = scripted ? parsed.positionals : parsed.positionals.slice(1);
      if (parsed.options['--in-place']) parsed.writes.push(...edited);
      // A backup suffix: a `*` in it is the file's name, and with a `/`, it's a path of its own.
      for (const suffix of parsed.options['--in-place'] ?? []) {
        if (suffix === true) continue;
        const text = staticValue(suffix);
        for (const file of edited) {
          const name = staticValue(file);
          const plain = text !== undefined && !text.includes('*');
          const here = text !== undefined && name !== undefined && !name.includes('/');
          parsed.writes.push(
            plain && name !== undefined
              ? { kind: 'static', value: name + text }
              : here
                ? { kind: 'static', value: text.replaceAll('*', name) }
                : dynamicArg('…', 'placeholder', false, ''),
          );
        }
      }
      if (!scripted && parsed.positionals.length > 0) parsed.reads = parsed.reads.filter((arg) => arg !== parsed.positionals[0]);
    },
  },
  'awk|gawk|mawk|nawk': {
    effects: ['fs:read'],
    options: opts(
      o('-f= --file=', { role: 'read', effects: ['exec:file'] }),
      o('-e= --source=', { effects: ['exec:arbitrary'] }),
      o('-i= --include=', { role: 'read', effects: ['exec:file'] }),
      o('-l= --load=', { effects: ['exec:file'] }),
      o('-E= --exec=', { role: 'read', effects: ['exec:file'] }),
      '-F= --field-separator=',
      '-v= --assign=',
      '--posix',
      '--sandbox',
      '--help',
      '--version',
    ),
    finish(parsed) {
      // An option this doesn't know may name the program's file, or take the program as its value.
      if (parsed.unknownOptions.length > 0) parsed.effects.add('exec:arbitrary');
      if (['--file', '--source', '--include', '--exec'].some((name) => parsed.options[name] !== undefined)) return;
      const [program] = parsed.positionals;
      if (!program) return;
      const code = staticValue(program);
      if (code === undefined) parsed.effects.add('exec:arbitrary');
      else scanAwk(code, parsed);
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
      '-P= --pattern=',
      '-I= --ignore=',
      '-H=',
      '-T=',
      '-R',
      '--charset=',
      '--filelimit=',
      '--timefmt=',
      o('-o= --output=', { role: 'write', effects: ['fs:write'] }),
    ),
    // tree reads a cluster's letters one at a time, each that takes a value taking the next word (`-Lo 2 x` writes x);
    // only -L takes digits in its own word.
    parse(args, parsed) {
      const spec = { ...programs.tree!, parse: undefined };
      const taking = new Set(spec.options!.filter((option) => option.value === true).flatMap((option) => option.names));
      const words: Arg[] = [];
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        const value = staticValue(arg);
        if (value === undefined || !/^-[^-]./.test(value) || /^-L\d+$/.test(value)) {
          words.push(arg);
          continue;
        }
        // Each letter on its own, followed by the value it takes from the words after the cluster.
        for (const letter of value.slice(1)) {
          words.push({ kind: 'static', value: `-${letter}` });
          if (taking.has(`-${letter}`) && i + 1 < args.length) words.push(args[++i]!);
        }
      }
      Object.assign(parsed, normalize(words, spec));
    },
  },
  date: {
    abbreviations: true,
    options: opts(
      o('-f= --file=', { role: 'read' }),
      o('-s= --set=', { effects: ['privilege'] }),
      '-d= --date=',
      o('-r= --reference=', { role: 'read' }),
      '-u --utc --universal',
      '-R --rfc-email',
      '-I=? --iso-8601=?',
      '--rfc-3339=',
      '--debug',
      '--help',
      '--version',
    ),
    finish(parsed) {
      // A word that isn't a `+format` is a time to set the clock to, and an option this doesn't know may set it too.
      const sets = parsed.positionals.some((arg) => !(arg.kind === 'static' ? arg.value : arg.prefix).startsWith('+'));
      if (sets || parsed.unknownOptions.length > 0) parsed.effects.add('privilege');
    },
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
  mkdir: writer('fs:write', '-p --parents', '-m= --mode=', '-v --verbose', '-Z', '--context=?'),
  // `-m` is the modification time, no mode: the word after it is a file.
  touch: writer('fs:write', '-a', '-c --no-create', '-d= --date=', '-f', '-h --no-dereference', '-m', '-r= --reference=', '-t=', '--time='),
  truncate: writer('fs:write', '-c --no-create', '-o --io-blocks', '-r= --reference=', '-s= --size='),
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
  'cat|less|more|wc|stat|nl|od|strings|md5sum|sha1sum|sha224sum|sha256sum|sha384sum|sha512sum|b2sum|cksum|cmp|tac|rev|base64': reader(
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
  file: {
    ...reader('-m= --magic-file=', '-f= --files-from=', '-F= --separator=', '-e= --exclude=', '-P= --parameter=', '-C --compile'),
    finish(parsed) {
      // -C compiles the magic file into one named after it, in the working directory.
      if (!parsed.options['--compile']) return;
      parsed.writes.push(dynamicArg('compiled magic', 'placeholder', false, ''));
      parsed.effects.add('fs:write');
    },
  },
  yq: {
    ...reader(
      '-i --inplace --in-place',
      '-s= --split-exp=',
      o('--split-exp-file=', { role: 'read' }),
      o('--from-file=', { role: 'read' }),
      '--security-allow-write-any-path',
      o('--security-enable-system-operator', { effects: ['exec:arbitrary'] }),
    ),
    finish(parsed) {
      // In place, the files it's given are rewritten; split, it writes files named by an expression.
      const split = parsed.options['--split-exp'] || parsed.options['--split-exp-file'];
      if (parsed.options['--inplace']) parsed.writes.push(...parsed.positionals);
      if (split) parsed.writes.push(dynamicArg('split output', 'placeholder', false, ''));
      if (parsed.options['--inplace'] || split) parsed.effects.add('fs:write');
    },
  },
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
      o('--hostname-bin=', { effects: ['exec:arbitrary'] }),
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
    o('-T= --temporary-directory=', { role: 'write' }),
    '-n --numeric-sort',
    '-r --reverse',
    '-u --unique',
    '-h --human-numeric-sort',
    '-f --ignore-case',
    '-V --version-sort',
    o('-o= --output=', { role: 'write', effects: ['fs:write'] }),
    o('--compress-program=', { effects: ['exec:arbitrary'] }),
  ),
  'cut|tr|paste|join|fold|fmt|column|expand|unexpand|diff|comm|jq|du|realpath|readlink|basename|dirname': reader(
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
  'echo|printf|true|false|pwd|whoami|id|uname|which|seq|sleep|yes|nproc|uptime|tput|clear|printenv|ps|pgrep|df|free': {},
};

/** The spec for a program by name, or `undefined` when it has none. */
export function specFor(program: string): CommandSpec | undefined {
  return specs.get(program);
}

const specs = new Map(Object.entries(programs).flatMap(([key, spec]) => key.split('|').map((name) => [name, spec] as const)));
