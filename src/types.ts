export type Decision = 'allow' | 'ask' | 'deny';

/** Why a word's value is only known at run time. */
export type DynamicReason = 'variable' | 'positional' | 'substitution' | 'arithmetic' | 'glob' | 'stdin' | 'placeholder';

/**
 * A command-line argument once every expansion the analysis can follow is done: a known string, or a value only the
 * run will know. `split` marks an unquoted dynamic word, which may become no words or many (and so may be options);
 * `prefix` is the static text before the first dynamic part (`--out=` in `--out=$f`).
 */
export type Arg = { kind: 'static'; value: string } | { kind: 'dynamic'; text: string; reason: DynamicReason; split: boolean; prefix: string };

/**
 * What running an invocation can do, beyond printing:
 * - `exec:arbitrary` runs code given inline in another language, or a string the analysis can't see into;
 * - `exec:project` runs code the project defines (package scripts, Makefiles, git hooks);
 * - `exec:file` runs a script or program file that isn't a system program;
 * - `exec:remote` runs a command on another machine;
 * - `shell-state` changes how later commands resolve (`PATH`, `hash -p`, `enable`).
 */
export type Effect =
  | 'fs:read'
  | 'fs:write'
  | 'fs:delete'
  | 'network'
  | 'privilege'
  | 'exec:arbitrary'
  | 'exec:project'
  | 'exec:file'
  | 'exec:remote'
  | 'shell-state';

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
  /** Whether a spec describes the program: without one, options are guessed (`-ab` as `-a -b`). */
  specified: boolean;
  effects: Effect[];
  reads: Arg[];
  writes: Arg[];
  /** The working directory it runs in, relative to where the script starts unless that was given; `undefined` when unknown. */
  cwd: string | undefined;
  /** Wrappers it runs under, outermost first: `['sudo', 'env']`. */
  via: string[];
  /** How it's reached from the top-level script: `['$(…)', 'bash -c', 'eval']`. */
  nesting: string[];
  /** A normalised form for display and grouping: `git push --force <arg> <arg>`. */
  shape: string;
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
  | 'sensitive-variable'
  | 'exec-config'
  | 'too-deep';

/** Something about the script itself, not one invocation, that a gate should know: what the analysis couldn't follow. */
export interface Finding {
  kind: FindingKind;
  message: string;
  span: [number, number];
}

export interface Analysis {
  source: string;
  invocations: Invocation[];
  findings: Finding[];
}
