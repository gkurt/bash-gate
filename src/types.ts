export type Decision = 'allow' | 'ask' | 'deny';

/** Why a word's value is only known at run time. */
export type DynamicReason = 'variable' | 'positional' | 'substitution' | 'arithmetic' | 'glob' | 'stdin' | 'placeholder';

/**
 * A command-line argument once every expansion the analysis can follow is done: a known string, or a value only the
 * run will know. `split` marks an unquoted dynamic word, which may become no words or many (and so may be options);
 * `prefix` is the static text before the first dynamic part (`--out=` in `--out=$f`).
 */
export type Arg =
  | { kind: 'static'; value: string }
  | { kind: 'dynamic'; text: string; reason: DynamicReason; split: boolean; prefix: string };

/**
 * What running an invocation can do, beyond printing:
 * - `network:read` only reads, from a host already set up (a git remote by its name, GitHub through `gh`), where
 *   `network` is every other way of reaching one;
 * - `exec:arbitrary` runs code given inline in another language, or a string the analysis can't see into;
 * - `exec:project` runs code the project defines (package scripts, Makefiles, git hooks);
 * - `exec:file` runs a script or program file that isn't a system program;
 * - `exec:remote` runs a command on another machine;
 * - `shell-state` changes how later commands resolve (`PATH`, `hash -p`, `enable`);
 * - `secrets:read` reads what is likely a secret: the environment as a whole (`printenv`, `env`, `export -p`), a file
 *   that holds credentials (`.env`, `~/.ssh/id_*`, `~/.aws/credentials`, `*.pem`), a variable named like one
 *   (`$GITHUB_TOKEN`), or a tool's own (`kubectl get secret -o yaml`, `terraform output -json`);
 * - `secrets:print` also puts that secret whole on the script's output: a program that copies what it reads unchanged
 *   (`cat .env`, `echo $GITHUB_TOKEN`, `printenv`, `kubectl get secret -o yaml`) whose output isn't redirected to a
 *   file, piped or captured (`$(…)`). One that transforms what it reads (`grep`, `cut`, `jq`) doesn't.
 *
 * A dry run's effects are what the rehearsal does: it reads and may run project code, but doesn't write, delete,
 * change a remote or run anything remotely (see `Invocation.dryRun`).
 */
export type Effect =
  | 'fs:read'
  | 'fs:write'
  | 'fs:delete'
  | 'network'
  | 'network:read'
  | 'privilege'
  | 'exec:arbitrary'
  | 'exec:project'
  | 'exec:file'
  | 'exec:remote'
  | 'shell-state'
  | 'secrets:read'
  | 'secrets:print';

export interface Invocation {
  /** The program as it resolves (the file's name when given as a path), or `null` when the command word is dynamic. */
  program: string | null;
  /** The path it was given by (`/bin/rm`, `./ls`) or that `hash -p` set, when not looked up in `PATH`. */
  path?: string;
  kind: 'external' | 'builtin' | 'function';
  /** The arguments, the program first, as the analysis resolved them. */
  argv: Arg[];
  /** Subcommands recognised from the program's spec: `['push']` for `git push`, `['stash', 'pop']`. */
  subcommands: string[];
  /** A subcommand word that isn't known (or is dynamic): it may be an alias or a plugin. */
  unknownSubcommand?: Arg;
  /** Options under their canonical names (`-f` and `--forc` are `--force`), each with its values (`true` when it takes none). */
  options: Record<string, (Arg | true)[]>;
  /** Options the spec doesn't know (or the program has no spec): their spelling as written. */
  unknownOptions: string[];
  positionals: Arg[];
  /** A dynamic word may be (or expand to) options, so an option not seen may still be there. */
  maybeOptions: boolean;
  /** More arguments come at run time: `xargs` appends lines of input, `find -exec … {}` paths. */
  open: boolean;
  /**
   * The file it runs isn't known (`hash -p` gave the name a path only known at run time), or it runs code the analysis
   * doesn't read (a git hook in another language): any program may run, from anywhere, and so may what it starts.
   */
  unplaced?: true;
  /** Whether a spec describes the program: without one, options are guessed (`-ab` as `-a -b`). */
  specified: boolean;
  effects: Effect[];
  reads: Arg[];
  writes: Arg[];
  /** Of `writes`, those its own arguments name (`sort -o`, `sed`'s `w`), not its redirections'. */
  outputs: Arg[];
  /** The working directory it runs in, relative to where the script starts unless that was given; `undefined` when unknown. */
  cwd: string | undefined;
  /** The directory `~` stands for where it runs: `$HOME`, when that's known and absolute. */
  home?: string;
  /**
   * With a filesystem and an absolute `cwd`: where each static positional and write really is, by its resolved
   * absolute path. `null` when that can't be known: the filesystem didn't say, or the script may have put a symlink
   * on the way.
   */
  realpaths?: Record<string, string | null>;
  /** Wrappers it runs under, outermost first: `['sudo', 'env']`. */
  via: string[];
  /** How it's reached from the top-level script: `['$(…)', 'bash -c', 'eval']`. */
  nesting: string[];
  /** A normalised form for display and grouping: `git push --force <arg> <arg>`. */
  shape: string;
  /**
   * For a dry run (`git push --dry-run`, `kubectl apply --dry-run=server`, `terraform plan`), the real command it
   * rehearses: its text and shape, and the effects it would have. A caller can match a later real run by shape and
   * arguments, as evidence that it was rehearsed. `effects` above are the rehearsal's own.
   */
  dryRun?: { text: string; shape: string; effects: Effect[] };
  /** Where it is in the source the analysis was given (the outer word for code parsed from a string). */
  span: [number, number];
  text: string;
}

export type FindingKind =
  | 'parse-error'
  | 'dynamic-command'
  | 'dynamic-script'
  | 'unknown-alias'
  | 'loads-code'
  | 'dynamic-arithmetic'
  | 'sensitive-variable'
  | 'exec-config'
  | 'too-deep'
  | 'unknown-syntax'
  | 'unknown-file'
  | 'project-file';

/** Something about the script itself, not one invocation, that a gate should know: what the analysis couldn't follow. */
export interface Finding {
  kind: FindingKind;
  message: string;
  span: [number, number];
}

/** Something the analysis asked the filesystem that it didn't know: answering it may settle an `unknown-file` finding. */
export interface Need {
  kind: 'file' | 'realpath' | 'directory';
  path: string;
}

export interface Analysis {
  source: string;
  /** The absolute directory the script starts in, when it was given: relative globs match paths from it. */
  cwd?: string;
  /** With a filesystem, where `cwd` really is; `null` when that isn't known. */
  realcwd?: string | null;
  /** HOME as the script starts, when it's absolute: `~` globs match from it too, whatever the script does to HOME. */
  home?: string;
  /** With a filesystem and HOME, where HOME really is; `null` when that isn't known. `~` globs match from it too. */
  realhome?: string | null;
  invocations: Invocation[];
  findings: Finding[];
  /** What to fetch before analysing again (see `checkAsync`). Empty without a filesystem, or when it knew everything. */
  needs: Need[];
}
