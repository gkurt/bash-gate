import {
  forEachChild,
  parse,
  type AndOr,
  type ArithmeticExpression,
  type Assignment,
  type Command,
  type CommandNode,
  type CompoundList,
  type Function as FunctionNode,
  type ParsedScript,
  type PipelineNode,
  type Redirection,
  type Statement,
  type SyntaxNode,
  type Word,
  type WordPart,
} from 'unbash';
import { assignment, emptyParsed, flag, normalize, type Parsed } from './argv.ts';
import { Changes, compare, Probe, type FileSystem } from './files.ts';
import { huskyHook } from './husky.ts';
import { basename, isSystemPath, resolvePath } from './paths.ts';
import { gitConfig, specFor } from './specs.ts';
import type { Analysis, Arg, Effect, FindingKind, Invocation } from './types.ts';
import {
  bracesDisagree,
  decodeAnsiC,
  dynamicArg,
  expandText,
  expandsBraces,
  joinStatic,
  resolveValue,
  resolveWord,
  resolveWords,
  subscriptEnd,
  type Lookup,
  type Value,
} from './words.ts';

/** What the analysis knows of where the command runs. */
export interface Environment {
  /**
   * The absolute directory the script starts in: relative globs in rules match from it. Without it, paths stay relative
   * to wherever that is, and an absolute path may be anywhere against it.
   */
  cwd?: string;
  /** Variables the shell starts with. Any other variable read before it's set is dynamic. */
  env?: Record<string, string>;
  /**
   * The filesystem before the command runs. Git config, hooks, npm scripts and SSH config files are read from it and
   * walked as code, and paths are resolved through symlinks. A file the script may change before it's read, or a path
   * it may put a symlink on, is unknown. Give an absolute `cwd` with it: otherwise any write makes later reads unknown.
   */
  fs?: FileSystem;
  /** How deep code inside code (`bash -c "eval '…'"`) is followed before the analysis gives up on it. */
  maxDepth?: number;
}

/** What the shell knows at a point in the script. */
interface State {
  vars: Map<string, Value>;
  exported: Set<string>;
  /** Functions by name: every definition that may be current, and whether it may not be defined at all. */
  functions: Map<string, { bodies: Body[]; maybeUndefined: boolean }>;
  exportedFunctions: Set<string>;
  aliases: Map<string, Alias>;
  aliasesUnknown: boolean;
  /** `shopt -s expand_aliases` (or POSIX mode): on, off, or `undefined` when it may be either. */
  expandAliases: boolean | undefined;
  /** POSIX mode: on, off, or `undefined` when it may be either. */
  posix: boolean | undefined;
  /** `hash -p` paths by name; `undefined` for one set dynamically. */
  hashed: Map<string, string | undefined>;
  /** Whether any name may have a path the analysis doesn't know (`BASH_CMDS` assigned). */
  hashUnknown: boolean;
  /** Variables that may be namerefs (`declare -n`): assigning or unsetting one changes another variable. */
  refs: Set<string>;
  /** The shell options in `followed`, by name: on, or `undefined` when it may be either. Absent is off. */
  options: Map<string, boolean | undefined>;
  /** Exported variables and functions that may not be: a shell started now may not get them. */
  maybeExported: Set<string>;
  maybeExportedFunctions: Set<string>;
  /** Builtins turned off with `enable -n`: the name runs the program instead. */
  disabled: Set<string>;
  /** Variables with the integer attribute (`declare -i`): what they're assigned is evaluated as arithmetic. */
  integers: Set<string>;
  /** Those of `integers` that may not have it: what they're assigned is only known at run time. */
  maybeIntegers: Set<string>;
  /** The function calls being run, innermost last, and the variables each made local. */
  frames: Frame[];
  /**
   * Variables whose case Bash changes when they're assigned (`declare -u`, `-l`, `-c`): `undefined` when it may or may
   * not, or differently.
   */
  cases: Map<string, Case | undefined>;
  cwd: string | undefined;
  /**
   * Set by a `cd` that may fail: where the shell still is if the command that just ran failed, while `cwd` is where it
   * is if it succeeded. `&&`, `||`, `!` and `if` read the status; any other next command makes it either.
   */
  failedCwd: { cwd: string | undefined } | undefined;
  /**
   * Code that may run between any two commands from now on (a trap action, a prompt string), by where it's set (a
   * signal, a variable). Each slot may hold several: what was set on different ways through the script.
   */
  later: Map<string, Later[]>;
}

/** Code that runs later: `walk` walks it in a state, silently or not. `key` says where it was set and what it is. */
interface Later {
  key: string;
  walk: (state: State, silent: boolean) => void;
}

/**
 * The aliases a command is parsed with. Bash expands aliases while parsing, and parses a line (or a compound command
 * spanning lines) before running any of it, so a command sees the aliases defined before its line began.
 */
interface Aliases {
  table: Map<string, Alias>;
  unknown: boolean;
  expand: boolean | undefined;
}

/**
 * An alias: its value, unknown (`undefined`) for a dynamic definition or one that differs between branches, and
 * whether it may not be defined at all (defined or removed in one branch only).
 */
interface Alias {
  value: string | undefined;
  maybe: boolean;
}

/**
 * A function call's own variables: `locals` it surely made local, put back when it returns, and `unknown` ones it may
 * have (`if c; then local x; fi`), or whose global was changed under it (`declare -g`): only known at run time after.
 */
interface Frame {
  locals: Set<string>;
  /** What each of `locals` was outside when it was made local, which is what the return puts back. */
  outer: Map<string, Outer>;
  unknown: Set<string>;
  /** `local -`: the `set` options as they were, which the return puts back, and whether it may not have run. */
  saved?: SavedOptions;
}

/** A variable's value and attributes outside a function call, as `local` found them. */
interface Outer {
  value: Value | undefined;
  exported: boolean;
  integers: boolean;
  maybeIntegers: boolean;
  cased: boolean;
  case: Case | undefined;
}

/** POSIX mode, `expand_aliases` and the followed `set` options, as `local -` saves them. */
interface SavedOptions {
  posix: boolean | undefined;
  expandAliases: boolean | undefined;
  set: Map<string, boolean | undefined>;
  maybe: boolean;
}

/** A function definition, with the aliases its body was parsed with. */
interface Body {
  node: FunctionNode;
  aliases: Aliases;
  /** The code it was defined in, which its positions index, wherever it's called from. */
  source: string;
  outer?: [number, number];
}

/** Where `break` and `continue` leave a loop: the state at each, which holds after it or as it goes round. */
interface Jumps {
  breaks: State[];
  continues: State[];
}

/** A loop settled from some state: what held then, and the jumps its walks left at the loops and call outside it. */
interface Settled {
  state: State;
  escapes: State[][];
}

/** Where the walk is: the source positions index, and how it got there. */
interface Context {
  source: string;
  /** The loops it's in, innermost last, in this function or shell: `break` and `continue` reach them. */
  loops: Jumps[];
  /** In a function call, the states at each `return`: they hold after the call, as the end of the body does. */
  returns?: State[];
  /** For code parsed from a string, the span of what holds it in the top-level source. */
  outer?: [number, number];
  aliases: Aliases;
  /**
   * Aliases whose text Bash is reading, by where that text ends in `source`: a word that starts before then is in it,
   * and isn't expanded again. Bash stops reading an alias's text at its end, so a word after it may be the alias again.
   */
  expanding: Expanding[];
  nesting: string[];
  via: string[];
  depth: number;
  /** Function bodies being called, so recursion stops even when a name is redefined. */
  calls: FunctionNode[];
  /** Reached through `env`, `sudo`, `xargs`, `exec`…: no aliases, functions or builtins, only programs. */
  externalOnly: boolean;
  /** Files a compound command's redirections write and read, for each command in it. */
  writes: Arg[];
  reads: Arg[];
  /** Walking a loop body once to see what it changes: nothing is recorded. */
  silent: boolean;
  /** Code run with arguments appended (`mapfile -C`, a git shell alias): every command in it may get more. */
  open: boolean;
  /** Runs alongside the rest of the script (`&`, `<(…)`): what it reads may be written by what comes after. */
  concurrent: boolean;
  /** What the other commands of a pipeline it's in may write while it runs, as far as they're known. */
  alongside?: Written[];
  /**
   * Variables of a temporary environment around the command or a function call it's in (`x=a f`): a local of the
   * same name may start with its value.
   */
  temporary?: Set<string>;
  /**
   * Those of `temporary` a builtin exported or made read-only, for the command they're around (at `depth`, in
   * `calls`). Run as that command (`x=a export x`, `x=a command export x`), Bash keeps them after it, with the value
   * they have then (`true`). Run in code it reads (`eval`, `source`) Bash takes them back, and in a function it calls,
   * Bash 5.2 keeps them and 5.3 doesn't (`false`): the value is only known at run time.
   */
  kept?: { depth: number; calls: FunctionNode[]; names: Map<string, boolean> };
  /**
   * Text Bash parses only as it expands it (a here-document's body, a subscript or arithmetic expanded again): in POSIX
   * mode, its substitutions are parsed without aliases. Code parsed later (`eval`) has them again.
   */
  late?: boolean;
  /**
   * In a command substitution inside double quotes (`"$(…)"`), where Bash decodes a `$'…'` in a `${…}` operand, then
   * expands what it holds. Code parsed later (`eval`) is read as usual.
   */
  quoted?: boolean;
}

/** A simple command on its way to running. */
interface Call {
  span: [number, number];
  writes: Arg[];
  reads: Arg[];
  /** The command as written, when its command word is a plain word, which aliases may replace. */
  command?: Command;
  /** `command name`: functions are skipped. */
  noFunctions: boolean;
  open: boolean;
  cwd: string | undefined;
  home: string | undefined;
}

/**
 * Syntax of Bash's that dash reads otherwise or not at all: `&>`, `|&`, `((` (not `$((`), `$'…'`, `$"…"`, `$[…]`,
 * `<<<`, process substitution, `[[`, `;&`, brace expansion, `function`, `select`, `coproc`, arrays, and expansions
 * POSIX doesn't have (`${x:1}`, `${x/a/b}`, `${x^}`, `${x,}`, `${!x}`, `${x@Q}`, `${a[0]}`).
 */
const bashOnly =
  /&>|\|&|(^|[^$])\(\(|\$['"[]|<<<|[<>]\(|\[\[|;;?&|\{[^\s{}]*(,|\.\.)[^\s{}]*\}|(^|[\s;&|(])(function|select|coproc)\s|\w=\(|\$\{(!|\w+(\[|:[\s\d]|\/|\^|,|@))/;

/** Words Bash reads as reserved where a command starts, and expands an alias of. */
const reservedWords = new Set([
  '!',
  'case',
  'coproc',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'time',
  'until',
  'while',
  '{',
  '}',
  '[[',
  ']]',
]);
/** The builtins POSIX calls special: in POSIX mode, Bash finds them before functions. */
const specialBuiltins = new Set([
  'break',
  ':',
  '.',
  'continue',
  'eval',
  'exec',
  'exit',
  'export',
  'readonly',
  'return',
  'set',
  'shift',
  'times',
  'trap',
  'unset',
]);
const builtins = new Set(
  ': . [ alias bg bind break builtin caller cd command compgen complete compopt continue declare dirs disown echo enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type typeset ulimit umask unalias unset wait'.split(
    ' ',
  ),
);

/** The option names `set -o` takes in Bash 5.3. */
const setOptions = new Set(
  'allexport braceexpand emacs errexit errtrace functrace hashall histexpand history ignoreeof interactive-comments keyword monitor noclobber noexec noglob nolog notify nounset onecmd physical pipefail posix privileged verbose vi xtrace'.split(
    ' ',
  ),
);

/**
 * Variables that change what runs, where it's looked up or which host it calls, for the shell or the programs it starts
 * (prompt strings and `PROMPT_COMMAND` are walked as code instead).
 */
const sensitive =
  /^(PATH|PWD|POSIXLY_CORRECT|RIPGREP_CONFIG_PATH|BASH_FUNC_.+|EXECIGNORE|BASH_ENV|ENV|IFS|SHELLOPTS|BASHOPTS|BASH_LOADABLES_PATH|TEXTDOMAIN|TEXTDOMAINDIR|CDPATH|HOME|ZDOTDIR|TMPDIR|XDG_CONFIG_HOME|LD_[A-Z_]+|DYLD_[A-Z_]+|GIT_[A-Z0-9_]+|GH_(PAGER|EDITOR|BROWSER|CONFIG_DIR|PATH|HOST|REPO)|(HTTPS?|ALL)_PROXY|(https?|all)_proxy|BROWSER|PAGER|MANPAGER|MANOPT|SHELL|GCONV_PATH|GNUPGHOME|SSLKEYLOGFILE|GNUTLS_KEYLOGFILE|BUN_INSPECT\w*|BIOME_LOG_PATH|(HOST_|TARGET_)?(CC|CXX|CPP|AR|LD|RANLIB)(_\w+)?|(HOST_|TARGET_)?(C|CXX|CPP|LD)FLAGS(_\w+)?|pnpm_config_\w+|PNPM_CONFIG_\w+|EDITOR|VISUAL|LESS|LESSOPEN|LESSCLOSE|LESSKEY\w*|NODE_OPTIONS|BUN_OPTIONS|CARGO_[A-Z0-9_]+|RUSTC(_WRAPPER|_WORKSPACE_WRAPPER)?|RUSTDOC|RUSTFLAGS|RUSTDOCFLAGS|RUSTUP_TOOLCHAIN|RUSTUP_HOME|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|SSH_ASKPASS|SUDO_ASKPASS|npm_config_\w+|NPM_CONFIG_\w+)$/;

/** Redirections that may leave the shell's output or errors on a file opened for reading: `1<f`, `<>`, `1>&3`. */
const opensOutputs = /\d<(?![<(])|<>|>&\s*[3-9]/;

/** Whether writing `path` writes the file a descriptor is open on, which may have been opened for reading. */
function reopens(path: string, outputsRead: boolean): boolean {
  const device = /^\/dev\/(stdin|stdout|stderr|fd\/\d+)$/.exec(path.replace(/\/+/g, '/'))?.[1];
  return device !== undefined && (outputsRead || (device !== 'stdout' && device !== 'stderr'));
}

/** Files a redirection may name without touching the file system. */
const devices = /^\/dev\/(null|stdin|stdout|stderr|tty|fd\/\d+)$/;
/** The words a run adds after a command's own (`xargs` appends its input's). */
const appended = dynamicArg('…', 'stdin', true, '');

/** Statically analyses a Bash script: every program it may run, with what, and what the analysis couldn't follow. */
export function analyze(source: string, environment: Environment = {}): Analysis {
  const script = parse(source);
  const files = environment.fs ? new Probe(environment.fs) : undefined;
  const walk = (silent: boolean, everything?: Written, members?: Map<object, Written>): Walker => {
    const state: State = {
      vars: new Map(Object.entries(environment.env ?? {}).map(([name, value]) => [name, { kind: 'static', value }])),
      exported: new Set(Object.keys(environment.env ?? {})),
      functions: new Map(),
      exportedFunctions: new Set(),
      aliases: new Map(),
      aliasesUnknown: false,
      // Bash starts in POSIX mode when it's in the environment.
      expandAliases: environment.env?.POSIXLY_CORRECT !== undefined,
      posix: environment.env?.POSIXLY_CORRECT !== undefined,
      hashed: new Map(),
      hashUnknown: false,
      refs: new Set(),
      options: new Map(),
      maybeExported: new Set(),
      maybeExportedFunctions: new Set(),
      disabled: new Set(),
      integers: new Set(startingIntegers),
      maybeIntegers: new Set(),
      frames: [],
      cases: new Map(),
      cwd: environment.cwd ?? '.',
      failedCwd: undefined,
      later: new Map(),
    };
    const context: Context = {
      source,
      aliases: snapshot(state),
      expanding: [],
      nesting: [],
      via: [],
      depth: 0,
      calls: [],
      loops: [],
      externalOnly: false,
      writes: [],
      reads: [],
      silent,
      open: false,
      concurrent: false,
    };
    const walker = new Walker({ source, invocations: [], findings: [], needs: [] }, environment.maxDepth ?? 12, files, everything, members);
    const start = environment.cwd ?? '.';
    walker.start = start.startsWith('/') ? (resolvePath('/', start) ?? start) : start;
    walker.outputsRead = opensOutputs.test(source);
    walker.script(script, state, context);
    return walker;
  };
  // Code that runs alongside the rest may read what the script writes after it: a silent first walk finds all of that,
  // and what each command of a pipeline writes, for the others.
  const first = files ? walk(true) : undefined;
  const { analysis } = walk(false, first?.written, first?.members);
  const start = environment.cwd?.startsWith('/') ? resolvePath('/', environment.cwd) : undefined;
  if (start !== undefined) analysis.cwd = start;
  if (start !== undefined && files) analysis.realcwd = files.physical(start) ?? null;
  if (files) analysis.needs = [...files.needs.values()];
  return analysis;
}

/** What the script may have written: files' contents, and paths where a symlink may now be. */
interface Written {
  contents: Changes;
  links: Changes;
}

/**
 * What a program's writes change for a later read: nothing (`mkdir`, `touch` and `chmod` leave contents alone), files'
 * contents, or also where symlinks are (`ln`, `cp`, `mv`, `tar` and anything else).
 */
function writeKind(program: string): 'none' | 'contents' | 'links' {
  if (/^(mkdir|touch|chmod|chown|chgrp)$/.test(program)) return 'none';
  return /^(tee|truncate|dd|rm|rmdir|unlink|shred)$/.test(program) ? 'contents' : 'links';
}

/** Git subcommands (by canonical name) that may rewrite files in the work tree. */
const gitWritesTree =
  /^(checkout|switch|restore|reset|merge|rebase|cherry-pick|revert|pull|apply|am|mv|clean|submodule|filter-branch|gc|sparse-checkout|lfs|bisect( \S+)?|stash( (push|save|pop|apply|branch))?)$/;

const commitHooks = 'pre-commit prepare-commit-msg commit-msg post-commit post-rewrite';
const mergeHooks = `pre-merge-commit post-merge pre-auto-gc ${commitHooks}`;
const rebaseHooks = `pre-rebase post-checkout ${mergeHooks}`;
/** What any command runs that writes the index (`git status` does, refreshing it) or a ref. */
const writeHooks = 'post-index-change reference-transaction';
const otherHooks = `${rebaseHooks} applypatch-msg pre-applypatch post-applypatch pre-push pre-receive update proc-receive post-receive post-update push-to-checkout sendemail-validate fsmonitor-watchman p4-changelist p4-prepare-changelist p4-post-changelist p4-pre-submit`;

/**
 * The hooks a git command runs besides `writeHooks`, as git 2.55 runs them. `pre-auto-gc` is the `gc --auto` older
 * gits run after a command that adds objects.
 */
const gitHooks = new Map(
  Object.entries({
    commit: `${commitHooks} pre-auto-gc`,
    merge: mergeHooks,
    'rebase|pull': rebaseHooks,
    'cherry-pick|revert': commitHooks,
    am: 'applypatch-msg pre-applypatch post-applypatch pre-auto-gc',
    'checkout|switch|restore|stash branch': 'post-checkout',
    push: 'pre-push',
    'fetch|remote update|gc|maintenance': 'pre-auto-gc',
    'status|log|show|diff|blame|annotate|describe|rev-parse|rev-list|ls-files|ls-tree|ls-remote|show-ref|cat-file|shortlog|reflog|whatchanged|grep|merge-base|name-rev|count-objects|var|check-ignore|check-attr|for-each-ref|help|version|add|branch|tag|mv|rm|reset|stash|remote|config|update-ref|symbolic-ref|notes|clean':
      '',
  }).flatMap(([commands, hooks]) => commands.split('|').map((command) => [command, hooks] as const)),
);

/** The hooks a git command may run: every one, for a command `gitHooks` doesn't have (an alias, a plugin). */
function gitHooksOf(parsed: Parsed): string[] {
  const { subcommands, unknownSubcommand: unknown } = parsed;
  if (subcommands.length === 0 && !unknown) return [];
  // A first word the spec doesn't know is git's command of that name when it has one: an alias can't hide it.
  const words = !unknown ? subcommands : unknown.kind === 'static' && subcommands.length === 0 ? [unknown.value] : [];
  const hooks = gitHooks.get(words.join(' ')) ?? gitHooks.get(words[0] ?? '') ?? otherHooks;
  return `${writeHooks} ${hooks}`.trim().split(' ');
}

/**
 * Whether a program may write files the analysis can't name: one without a spec, one running code that isn't followed,
 * or one whose spec writes without saying where. Git's own writes are its work tree (`gitWritesTree`) and `.git`, but
 * a clone, a new worktree or an init lands somewhere else.
 */
function writesUnknown(program: string, parsed: Parsed, followed: boolean): boolean | 'project' {
  if (!specFor(program)) return true;
  const { effects } = parsed;
  if (effects.has('exec:arbitrary') || effects.has('exec:file')) return true;
  // Project code it doesn't follow (a test run, a build, a hook), and not code fetched as it runs (`npm install`).
  const project = effects.has('exec:project') && !followed && !effects.has('network');
  if (program === 'git') {
    const subcommands = parsed.subcommands.join(' ');
    if (/^(clone|init|worktree( (add|move|repair))?)$/.test(subcommands) || (!followed && gitWritesTree.test(subcommands))) return true;
  } else if ((effects.has('fs:write') || effects.has('fs:delete')) && parsed.writes.length === 0 && !specFor(program)?.edits) {
    // What project code writes without naming it (`cargo fmt`) is its own writing.
    return project ? 'project' : true;
  }
  if (project) return 'project';
  return effects.has('exec:project') && !followed;
}

/** Programs that run package.json scripts, by the options that run another package's scripts instead. */
const workspaces: Record<string, string[]> = {
  npm: ['--workspace', '--workspaces', '--include-workspace-root'],
  pnpm: ['--recursive', '--filter', '--filter-prod', '--workspace-root', '--global'],
  bun: ['--filter', '--workspaces'],
};
const packageManagers = new Set(Object.keys(workspaces));

/** The scripts npm's and pnpm's own commands run, in order. */
const lifecycleScripts: Record<string, string[]> = {
  pack: ['prepack', 'prepare', 'postpack'],
  version: ['preversion', 'version', 'postversion'],
};

/** How many times a loop body is walked looking for what it changes before the analysis gives up on it. */
const maxIterations = 32;

/** How many commands the analysis walks in all, so that no input costs more than this. */
const maxWork = 200_000;

class Walker {
  analysis: Analysis;
  maxDepth: number;
  /** Where the script starts: the project, whose code `exec:project` is. */
  start = '.';
  /** Commands walked so far, against `maxWork`. */
  work = 0;
  /** Each function definition once per alias table, so that a loop defining a function settles. */
  bodies = new Map<FunctionNode, Body[]>();
  /** Where each loop settles, by what held when it began (see `loop`). */
  settled = new Map<object, Map<string, Settled>>();
  ids = new Map<object, number>();
  /** What code that runs later left, by the code, whether it was walked silently, and the state it ran in. */
  ran = new Map<string, State>();
  /** Code that runs later being walked, which doesn't run again inside itself. */
  running = new Set<string>();
  /** What code that runs later emitted, which walking it in another state doesn't emit again. */
  emitted = new Set<string>();
  files: Probe | undefined;
  /** Whether code walked may open the shell's output or errors for reading (`1<f`, `<>`): see `redirections`. */
  outputsRead = false;
  /**
   * What the script may have written so far, in the order of the walk. The filesystem is shared by every shell the
   * script starts, so this isn't part of a shell's state, and it only grows: a branch's writes count after it.
   */
  written: Written = { contents: new Changes(), links: new Changes() };
  /** How many times `written` grew, so code walked before a write is walked again after it. */
  writes = 0;
  /** Whether git may have rewritten the work tree, for project code run after it without a filesystem to follow. */
  rewritten = false;
  /** Code in strings by its text: walked again, it defines the same functions, so what it does settles. */
  scripts = new Map<string, ParsedScript>();
  /** What the whole script may write, for code that runs alongside the rest. */
  everything: Written | undefined;
  /** What each command of a pipeline may write, by its node: recorded by the first walk, read by the second. */
  members: Map<object, Written>;
  /** Where writes are recorded besides `written`: the pipeline commands being walked. */
  trackers: Written[] = [];

  constructor(analysis: Analysis, maxDepth: number, files?: Probe, everything?: Written, members?: Map<object, Written>) {
    this.analysis = analysis;
    this.maxDepth = maxDepth;
    this.files = files;
    this.everything = everything;
    this.members = members ?? new Map();
  }

  /** `written` and the pipeline commands' records it's walking. */
  get recorded(): Written[] {
    return [this.written, ...this.trackers];
  }

  /** `writes` happen: `kind` is what they change for a later read (see `writeKind`). */
  wrote(writes: Arg[], call: Call, kind: 'none' | 'contents' | 'links'): void {
    if (!this.files || kind === 'none' || writes.length === 0) return;
    this.writes++;
    const sets = this.recorded.flatMap((written) => (kind === 'links' ? [written.contents, written.links] : [written.contents]));
    for (const arg of writes) {
      const path = arg.kind === 'static' ? resolvePath(call.cwd, arg.value, call.home) : undefined;
      // Through a symlink that's already there, a write lands somewhere else, and so does a `..` after one.
      const opened = arg.kind === 'static' ? this.openedPath(call.cwd, arg.value, call.home) : undefined;
      const real = opened?.startsWith('/') ? this.files.physical(opened) : undefined;
      for (const changes of sets) {
        changes.add(path);
        changes.add(opened);
        changes.add(real);
      }
    }
  }

  /**
   * A program writes files no one can name: from here on, every file and real path is unknown. With `project`, only
   * project code the analysis trusts does (see `Changes.project`).
   */
  wroteAnything(project = false): void {
    if (!this.files) return;
    this.writes++;
    for (const written of this.recorded) {
      for (const changes of [written.contents, written.links]) {
        if (project) changes.project = true;
        else changes.add(undefined);
      }
    }
  }

  /** A program rewrites files whose names match `pattern`, wherever they are, and puts no symlinks anywhere. */
  wrotePattern(pattern: RegExp): void {
    if (!this.files) return;
    this.writes++;
    for (const written of this.recorded) written.contents.addPattern(pattern);
  }

  /**
   * Git rewrites the work tree at `root`, files and symlinks, but not its `.git` (`git`). Whatever it checks out, from
   * a branch, a commit, a patch, or even `HEAD`, the index or a stash, may hold anything: an earlier command may have
   * committed, staged or stashed it.
   */
  wroteTree(root: string, git: string): void {
    if (!this.files) return;
    if (!root.startsWith('/')) return this.wroteAnything();
    this.writes++;
    const real = this.files.physical(root);
    const realGit = this.files.physical(git);
    for (const written of this.recorded) {
      for (const changes of [written.contents, written.links]) {
        changes.addTree(root, git);
        if (real === undefined || realGit === undefined) changes.add(undefined);
        else changes.addTree(real, realGit);
      }
    }
  }

  /**
   * Whether the script may have changed `path` before now: its contents, or (`links`) a symlink on its way.
   * `'project'` when only project code it trusts but doesn't follow may have.
   */
  changed(path: string, ctx: Context, kind: keyof Written): boolean | 'project' {
    const sets = [
      this.written[kind],
      ...(ctx.concurrent && this.everything ? [this.everything[kind]] : []),
      ...(ctx.alongside ?? []).map((written) => written[kind]),
    ];
    const named = sets.filter((changes) => changes.named);
    const real = path.startsWith('/') ? this.files?.physical(path) : undefined;
    if (named.length > 0 && (real === undefined || named.some((changes) => changes.covers(path) || changes.covers(real)))) return true;
    return sets.some((changes) => changes.project) ? 'project' : false;
  }

  /** A finding for a file the script may have changed before git or a package manager reads it. */
  changedFinding(path: string, changed: true | 'project', ctx: Context, call: Call, looked = false): void {
    const when = looked ? "before it's looked for" : "before it's read";
    if (changed === 'project') this.finding(ctx, 'project-file', `\`${path}\` may be changed by project code ${when}`, call.span);
    else this.finding(ctx, 'unknown-file', `\`${path}\` may be changed by the script ${when}`, call.span);
  }

  /** A file the command reads (Git config, a hook): its text, or `undefined` when it's absent or not known (a finding). */
  read(path: string, ctx: Context, call: Call): string | undefined {
    // A `~` with HOME unknown (`include.path = ~/x`) is no file the analysis can ask for.
    if (path.startsWith('~')) {
      this.finding(ctx, 'unknown-file', `Where \`${path}\` is isn't known`, call.span);
      return undefined;
    }
    const text = this.files!.readFile(path);
    const changed = this.changed(path, ctx, 'contents');
    if (changed !== false) this.changedFinding(path, changed, ctx, call);
    // What project code may have written in its place is its own: what was there is walked as well.
    if (changed === true) return undefined;
    if (text === undefined) this.finding(ctx, 'unknown-file', `What \`${path}\` holds isn't known`, call.span);
    return text ?? undefined;
  }

  /**
   * `path` from `base` as the kernel finds it, for a program that opens it as given (git's `core.hooksPath`): a `..`
   * after a symlink leads up from where the symlink does. `undefined` where that isn't known.
   */
  openedPath(base: string | undefined, path: string, home?: string): string | undefined {
    if (!this.files || !path.split('/').includes('..')) return resolvePath(base, path, home);
    const tilde = /^~(\/|$)/.test(path);
    const full = path.startsWith('/')
      ? path
      : tilde
        ? home === undefined
          ? undefined
          : home + path.slice(1)
        : base === undefined
          ? undefined
          : `${base}/${path}`;
    if (!full?.startsWith('/')) return undefined;
    let current = '';
    for (const step of full.split('/')) {
      if (step === '' || step === '.') continue;
      if (step !== '..') {
        current += `/${step}`;
        continue;
      }
      const real = this.files.physical(current || '/');
      if (real === undefined) return undefined;
      current = real.slice(0, real.lastIndexOf('/'));
    }
    return current || '/';
  }

  /** Where each static path in `args` really is, by its resolved absolute path (see `Invocation.realpaths`). */
  realpaths(args: Arg[], ctx: Context, call: Call): Record<string, string | null> {
    const realpaths: Record<string, string | null> = {};
    if (!call.cwd?.startsWith('/')) return realpaths;
    for (const arg of args) {
      const resolved = arg.kind === 'static' ? resolvePath(call.cwd, arg.value, call.home) : undefined;
      if (!resolved?.startsWith('/')) continue;
      // A `..` after a symlink leads up from where the symlink does (`link/../x`), not back to where it is.
      const opened = this.openedPath(call.cwd, (arg as Extract<Arg, { kind: 'static' }>).value, call.home);
      // A symlink project code may have put on the way is no more than what it could write itself.
      const unsure = opened === undefined || this.changed(resolved, ctx, 'links') === true || this.changed(opened, ctx, 'links') === true;
      const real = unsure ? null : (this.files!.physical(opened) ?? null);
      // Two words resolving alike may lead to different places: then neither is known.
      realpaths[resolved] = Object.hasOwn(realpaths, resolved) && realpaths[resolved] !== real ? null : real;
    }
    return realpaths;
  }

  /**
   * Code Bash parses as it runs (a script, `eval`, `bash -c`, a substitution): each line is parsed with the aliases
   * defined when it begins. `first` is the alias table for the first line when it continues one (an alias's text), or
   * for every line when it was all parsed at once (`whole`).
   */
  script(script: ParsedScript, state: State, ctx: Context, first?: Aliases, whole = false): void {
    for (const error of script.errors ?? []) this.finding(ctx, 'parse-error', `Parse error: ${error.message}`, [error.pos, error.pos]);
    this.carriageReturn(ctx.source, ctx);
    // Bash keeps a backslash that ends the code, or drops it after a quoted string over several lines.
    if (!first && /(?<!\\)(?:\\\\)*\\$/.test(ctx.source)) {
      const end = ctx.source.length;
      this.finding(ctx, 'parse-error', 'A backslash at the end of the code, which Bash may keep or drop', this.span(ctx, end - 1, end));
    }
    // An alias's text leaves out a here-document's body, which is after the command.
    if (!first && unclosed(script)) this.finding(ctx, 'parse-error', 'A here-document is never closed', this.span(ctx, 0, 0));
    let unit = first ? { aliases: first, expanding: ctx.expanding } : undefined;
    let previous: number | undefined;
    for (const statement of script.commands) {
      if (!unit || (!whole && previous !== undefined && ctx.source.slice(previous, statement.pos).includes('\n')))
        unit = { aliases: snapshot(state, ctx.late), expanding: [] };
      this.between(state, ctx);
      const shell = statement.background ? clone(state) : state;
      this.node(statement.command, shell, { ...ctx, ...unit, ...(statement.background ? { concurrent: true } : {}) });
      this.between(shell, ctx);
      previous = statement.end;
    }
  }

  list(statements: readonly Statement[], state: State, ctx: Context): void {
    for (const statement of statements) {
      this.between(state, ctx);
      const shell = statement.background ? clone(state) : state;
      this.node(statement.command, shell, statement.background ? { ...ctx, concurrent: true } : ctx);
      this.between(shell, ctx);
    }
  }

  /**
   * One command of a pipeline. The others run while it does, and the pipeline ends before the next command starts, so
   * what it reads may be changed by what the others write, never by its own later writes. The first walk records what
   * each writes; without that record (code parsed from a string), or in code already alongside the rest, it's
   * everything the script writes.
   */
  member(commands: readonly CommandNode[], command: CommandNode, shell: State, ctx: Context): void {
    const others = commands.filter((other) => other !== command).map((other) => this.members.get(other));
    const known = !ctx.concurrent && this.everything !== undefined && others.every((other) => other !== undefined);
    const record: Written = { contents: new Changes(), links: new Changes() };
    this.trackers.push(record);
    try {
      this.node(command, shell, known ? { ...ctx, alongside: [...(ctx.alongside ?? []), ...others] } : { ...ctx, concurrent: true });
    } finally {
      this.trackers.pop();
    }
    if (this.everything !== undefined) return;
    const recorded = this.members.get(command);
    if (!recorded) this.members.set(command, record);
    else for (const kind of ['contents', 'links'] as const) recorded[kind].merge(record[kind]);
  }

  node(node: PipelineNode | AndOr | CommandNode | CompoundList, state: State, ctx: Context): void {
    if (++this.work > maxWork) {
      // Recorded even in a silent walk: what follows isn't walked at all.
      this.alarm('The script is too large for the analysis to follow', [0, this.analysis.source.length]);
      return;
    }
    // Nothing reads the last command's status here: a `cd` before may or may not have changed directory.
    decided(state, 'either');
    switch (node.type) {
      case 'CompoundList':
        return this.list(node.commands, state, ctx);
      case 'AndOr': {
        const [first, ...rest] = node.commands;
        if (first) this.node(first, state, ctx);
        for (const [i, command] of rest.entries()) {
          this.between(state, ctx);
          const and = node.operators[i] === '&&';
          const branch = clone(state);
          decided(branch, and ? 'success' : 'failure');
          this.node(command, branch, ctx);
          // Skipped, the list's status is the one that skipped it: where the shell is on the other status never
          // happens there, so it takes the branch's.
          decided(state, and ? 'failure' : 'success');
          if (and) [state.failedCwd, state.cwd] = [{ cwd: state.cwd }, branch.cwd];
          else state.failedCwd = { cwd: (branch.failedCwd ?? branch).cwd };
          join(state, branch);
        }
        return;
      }
      case 'Pipeline': {
        const together = node.commands.length > 1;
        // With lastpipe and no job control, the last command runs in the shell itself: what it changes stays.
        const lastpipe =
          option(state, 'lastpipe') === false || option(state, 'monitor') === true
            ? false
            : option(state, 'lastpipe') && option(state, 'monitor') === false
              ? true
              : undefined;
        for (const [i, command] of node.commands.entries()) {
          const shell = together ? clone(state) : state;
          if (together) this.member(node.commands, command, shell, ctx);
          else this.node(command, shell, ctx);
          if (!together) continue;
          this.between(shell, ctx);
          if (i < node.commands.length - 1 || lastpipe === false) continue;
          if (lastpipe) Object.assign(state, shell);
          else join(state, shell);
        }
        // With pipefail, another command's failure may be the status.
        if (together) decided(state, 'either');
        if (node.prefixes.filter((prefix) => prefix.type === 'Negation').length % 2 === 1 && state.failedCwd)
          [state.cwd, state.failedCwd.cwd] = [state.failedCwd.cwd, state.cwd];
        return;
      }
      case 'Command':
        return this.simple(node, state, ctx);
      case 'If': {
        this.list(node.clause.commands, state, ctx);
        const then = (list: CompoundList) => (s: State, c: Context) => {
          decided(s, 'success');
          this.list(list.commands, s, c);
        };
        const outcomes = [this.branch(state, ctx, then(node.then))];
        // Each elif's clause, and the else, run after every clause before failed, with what those changed.
        const failed = clone(state);
        decided(failed, 'failure');
        for (const elif of node.elif) {
          this.list(elif.clause.commands, failed, ctx);
          outcomes.push(this.branch(failed, ctx, then(elif.then)));
          decided(failed, 'failure');
        }
        if (node.else) this.list(node.else.commands, failed, ctx);
        return settle(state, [...outcomes, failed]);
      }
      case 'For':
      case 'Select': {
        this.substitutions(node.wordlist ?? [], state, ctx);
        const values = (node.wordlist ?? []).flatMap((word) => resolveWord(word, lookupIn(state)));
        const only = values.length === 1 ? values[0] : undefined;
        // `select` sets the variable to what's chosen, which is nothing for a bad answer, and REPLY to the answer.
        const value: Value =
          only?.kind === 'static' && node.type === 'For' && node.wordlist?.length === 1
            ? tildeExpanded({ kind: 'static', value: only.value }, node.wordlist[0]!.text, state, false)
            : { kind: 'dynamic' };
        const call = this.at(ctx, state, node);
        state.vars.set(node.name.value, this.assigned(node.name.value, value, state, ctx, call, true));
        if (node.type === 'Select') state.vars.set('REPLY', this.assigned('REPLY', { kind: 'dynamic' }, state, ctx, call, true));
        return this.loop(state, ctx, node, (s, c) => this.list(node.body.commands, s, c));
      }
      case 'ArithmeticFor':
        if (node.initialize) this.arithmetic(node.initialize, state, ctx);
        if (node.test) this.arithmetic(node.test, state, ctx);
        // The update and the test run again after each pass, with what the body changed.
        return this.loop(state, ctx, node, (s, c) => {
          this.list(node.body.commands, s, c);
          for (const expression of [node.update, node.test]) if (expression) this.arithmetic(expression, s, c);
        });
      case 'While':
        return this.loop(state, ctx, node, (s, c) => this.list([...node.clause.commands, ...node.body.commands], s, c));
      case 'Case': {
        this.substitutions([node.word, ...node.items.flatMap((item) => item.pattern)], state, ctx);
        // An arm ending in ;& runs the next one too, and one ending in ;;& tests the patterns after it until one
        // matches: either way, what it changed holds there.
        const outcomes = [clone(state)];
        let testing: State | undefined;
        let falling: State | undefined;
        for (const item of node.items) {
          const start = clone(state);
          for (const carried of [testing, falling]) if (carried) join(start, carried);
          const end = this.branch(start, ctx, (s, c) => this.list(item.body.commands, s, c));
          outcomes.push(end);
          if (item.terminator === ';;&') testing = testing ? (join(testing, end), testing) : clone(end);
          falling = item.terminator === ';&' ? end : undefined;
        }
        return settle(state, outcomes);
      }
      case 'Subshell':
        return this.list(node.body.commands, clone(state), ctx);
      case 'BraceGroup':
        return this.list(node.body.commands, state, ctx);
      case 'TestCommand':
        return this.substitutions([node], state, ctx);
      case 'ArithmeticCommand':
        if (node.expression) this.arithmetic(node.expression, state, ctx);
        return;
      case 'Redirected': {
        this.substitutions(node.redirects, state, ctx);
        const files = redirections(node.redirects, lookupIn(state), this.outputsRead);
        // Bash opens the files before it runs what's in the group, and runs none of it when one can't be opened.
        const call = { ...this.at(ctx, state, node), writes: files.writes, reads: files.reads };
        this.wrote(files.writes, call, 'contents');
        const inner = { ...ctx, writes: [...ctx.writes, ...files.writes], reads: [...ctx.reads, ...files.reads] };
        if (files.writes.length === 0 && files.reads.length === 0) return this.node(node.command, state, inner);
        // Opened even when nothing in the group runs (`case a in b) ;; esac >f`, `(( 0 )) >f`), as `>f` alone is.
        this.emit(ctx, call, ':', 'builtin', [{ kind: 'static', value: ':' }], emptyParsed());
        return settle(state, [clone(state), this.branch(state, inner, (s, c) => this.node(node.command, s, c))]);
      }
      case 'Function': {
        // Bash refuses a name with quotes, escapes or expansions in it.
        if (!plain(node.name) || node.name.value.includes('$')) return;
        const define = (s: State, name: string) => {
          s.functions.set(name, { bodies: [this.body(node, ctx)], maybeUndefined: false });
          exportAll(s, name, s.exportedFunctions, s.maybeExportedFunctions);
        };
        // The name of `name()` (not `function name`) is a command word, which an alias replaces: `alias rm=zz; rm() …`
        // defines `zz`.
        const { table, unknown, expand } = ctx.aliases;
        const name = node.name.value;
        const bare = node.pos === node.name.pos && expand !== false;
        const alias = bare ? table.get(name) : undefined;
        const span = this.at(ctx, state, node).span;
        if (bare && unknown && !alias) this.finding(ctx, 'unknown-alias', `\`${name}\` may be an alias defined at run time`, span);
        if (!alias || active(ctx, node.name.pos).includes(name)) return define(state, name);
        const renamed = alias.value?.replace(/[ \t]+$/, '');
        if (renamed === undefined || !/^[\w.:+@%^,/-]+$/.test(renamed)) {
          this.finding(ctx, 'unknown-alias', `\`${name}\` is an alias, which makes this definition something else`, span);
          return;
        }
        if (expand && !alias.maybe) return define(state, renamed);
        return settle(state, [this.branch(state, ctx, (s) => define(s, renamed)), this.branch(state, ctx, (s) => define(s, name))]);
      }
      case 'Coproc': {
        this.node(node.body, clone(state), { ...ctx, concurrent: true });
        // The shell gets the coprocess's descriptors in NAME and its process ID in NAME_PID.
        const name = node.name?.value ?? 'COPROC';
        const call = this.at(ctx, state, node);
        for (const variable of [name, `${name}_PID`])
          state.vars.set(variable, this.assigned(variable, { kind: 'dynamic', numeric: true }, state, ctx, call, true));
        return;
      }
      default: {
        // A node this version doesn't know (a newer parser): what it runs can't be followed.
        const unknown = node satisfies never as { type: string; pos: number; end: number };
        this.finding(ctx, 'unknown-syntax', `Syntax the analysis doesn't know: ${unknown.type}`, this.span(ctx, unknown.pos, unknown.end));
      }
    }
  }

  /** Runs `walk` on a copy of `state`, for one way through a conditional. */
  branch(state: State, ctx: Context, walk: (state: State, ctx: Context) => void): State {
    const copy = clone(state);
    walk(copy, ctx);
    return copy;
  }

  /**
   * A loop body: walked silently until it changes nothing more (what it changes counts as dynamic), then once for real
   * from there. The loop may run any number of times, so what holds after it is joined with what held before.
   *
   * Where the loop settles is remembered by what held when it began: an outer loop walks an inner one each time it goes
   * round, mostly from the same few states, and walking it again each time would cost exponentially in the depth.
   */
  loop(state: State, ctx: Context, node: { pos: number; end: number }, walk: (state: State, ctx: Context) => void): void {
    const memo = this.settled.get(node) ?? new Map<string, Settled>();
    this.settled.set(node, memo);
    const key = this.key(state, ctx);
    const known = memo.get(key);
    // A jump past this loop (`break 2`, `return`) leaves its state outside: a settled loop isn't walked again, so the
    // ones its walks left are left again.
    const outside = [...ctx.loops.flatMap((jumps) => [jumps.breaks, jumps.continues]), ...(ctx.returns ? [ctx.returns] : [])];
    const breaks: State[] = [];
    const once = (s: State, c: Context) => {
      const jumps: Jumps = { breaks: [], continues: [] };
      walk(s, { ...c, loops: [...c.loops, jumps] });
      for (const other of jumps.continues) join(s, other);
      breaks.push(...jumps.breaks);
    };
    if (known) {
      Object.assign(state, clone(known.state));
      outside.forEach((list, i) => list.push(...known.escapes[i]!.map(clone)));
    } else {
      const before = outside.map((list) => list.length);
      for (let i = 0; ; i++) {
        const next = clone(state);
        join(next, this.branch(state, { ...ctx, silent: true }, once));
        for (const other of breaks.splice(0)) join(next, other);
        if (equal(next, state)) break;
        Object.assign(state, next);
        if (i === maxIterations) {
          this.alarm('A loop changes more than the analysis follows', this.span(ctx, node.pos, node.end));
          break;
        }
      }
      memo.set(key, { state: clone(state), escapes: outside.map((list, i) => list.slice(before[i]).map(clone)) });
    }
    // Settled, a silent walk has nothing more to learn: one more would only double the cost at every level.
    if (ctx.silent) return;
    join(state, this.branch(state, ctx, once));
    for (const other of breaks.splice(0)) join(state, other);
  }

  /** What a silent walk's outcome depends on: the state, and the parts of the context that change what it does. */
  key(state: State, ctx: Context): string {
    return JSON.stringify([
      this.stateKey(state),
      ctx.depth,
      ctx.externalOnly,
      ctx.calls.map((node) => this.id(node)),
      ctx.loops.length,
      ctx.returns !== undefined,
      aliasesKey(ctx.aliases.table),
      ctx.aliases.unknown,
      ctx.aliases.expand ?? null,
      ctx.expanding,
    ]);
  }

  stateKey(state: State): string {
    return JSON.stringify([
      sorted(state.vars),
      [...state.exported].sort(),
      sorted(state.functions).map(([name, fn]) => [name, fn.maybeUndefined, fn.bodies.map((body) => this.id(body)).sort((a, b) => a - b)]),
      [...state.exportedFunctions].sort(),
      aliasesKey(state.aliases),
      state.aliasesUnknown,
      state.expandAliases ?? null,
      state.posix ?? null,
      sorted(state.hashed).map(([name, path]) => [name, path ?? null]),
      state.hashUnknown,
      [...state.refs].sort(),
      sorted(state.options).map(([name, on]) => [name, on ?? null]),
      [...state.maybeExported].sort(),
      [...state.maybeExportedFunctions].sort(),
      [...state.disabled].sort(),
      [...state.integers].sort(),
      sorted(state.cases).map(([name, how]) => [name, how ?? null]),
      state.cwd ?? null,
      state.failedCwd ? [state.failedCwd.cwd ?? null] : null,
      sorted(state.later).map(([slot, code]) => [slot, code.map((later) => later.key).sort()]),
    ]);
  }

  id(object: object): number {
    let id = this.ids.get(object);
    if (id === undefined) this.ids.set(object, (id = this.ids.size));
    return id;
  }

  /** A finding recorded even in a silent walk, for when the analysis stops short and a later walk won't see why. */
  alarm(message: string, span: [number, number]): void {
    if (!this.analysis.findings.some((finding) => finding.message === message))
      this.analysis.findings.push({ kind: 'too-deep', message, span });
  }

  /** A call for something that isn't a simple command (a `for` loop, arithmetic), for where findings point. */
  at(ctx: Context, state: State, node: { pos: number; end: number }): Call {
    return {
      span: this.span(ctx, node.pos, node.end),
      writes: [],
      reads: [],
      noFunctions: false,
      open: false,
      cwd: state.cwd,
      home: homeOf(state),
    };
  }

  /** The definition of `node` parsed with `aliases`: the same object each time, so that states compare equal. */
  body(node: FunctionNode, ctx: Context): Body {
    const { aliases, source, outer } = ctx;
    const known = this.bodies.get(node) ?? [];
    const found = known.find((body) => sameAliases(body.aliases, aliases) && body.source === source);
    if (found) return found;
    const body = { node, aliases, source, outer };
    this.bodies.set(node, [...known, body]);
    return body;
  }

  /** Command substitutions and arithmetic evaluation hidden in `nodes`. */
  substitutions(nodes: readonly SyntaxNode[], state: State, ctx: Context): void {
    /** `again`: a substitution Bash parses again as it runs it. */
    const visit = (node: SyntaxNode, ctx: Context, again = false) => {
      if (node.type === 'Script') {
        const scriptCtx = node.source === undefined ? ctx : { ...ctx, source: node.source, outer: ctx.outer ?? [node.pos, node.end] };
        const inner = { ...scriptCtx, nesting: [...ctx.nesting, '$(…)'] };
        // In POSIX mode Bash runs a command substitution as it parsed it with the line around it: with that line's
        // aliases, and none it defines itself. Otherwise it parses it again as it runs. A process substitution gets
        // both: the line's aliases, then those when it runs, so either may be what runs.
        if (state.posix !== false && !ctx.late) this.script(node, clone(state), inner, ctx.aliases, true);
        if (state.posix !== true || ctx.late || again) this.script(node, clone(state), inner);
        return;
      }
      if (node.type === 'ProcessSubstitution') return forEachChild(node, (child) => visit(child, { ...ctx, concurrent: true }, true));
      if (node.type === 'ArithmeticExpansion') {
        if (node.expression) this.arithmetic(node.expression, state, ctx);
        return;
      }
      if (node.type === 'HereDocBody' && node.parts?.some((part) => part.type === 'ParameterExpansion' && part.text.includes("'"))) {
        // Bash expands the body as if it were in double quotes, so `'` in `${y:-'$(ls)'}` is only text, and `ls` runs.
        // The parser reads it as quoting, but not in a double-quoted string: the body is walked again as one.
        // So is `$` before one: `${y:-$'$(ls)'}` runs `ls` too.
        const text = node.parts.map((part) =>
          part.type === 'Literal'
            ? part.text.replaceAll(/\\[\s\S]|"/g, (m) => (m === '"' ? '\\"' : m))
            : part.type === 'ParameterExpansion'
              ? part.text.replaceAll(/\\[\s\S]|\$'/g, (m) => (m === "$'" ? "'" : m))
              : part.text,
        );
        this.expansions(text.join(''), state, ctx, this.at(ctx, state, node), 'here-document', true);
      }
      if (node.type === 'DoubleQuoted' || node.type === 'LocaleString' || node.type === 'HereDocBody') {
        // In `"${x:-"$"("ls)"}"`, and the same in `$"…"` or a here-document, Bash removes the inner quotes first and
        // expands what's left: `ls` runs. `$"…"` inside is quotes too: `$"""$"(` is `$(`.
        const expansion = /\$[({\w]|`/g;
        for (const part of node.parts ?? []) {
          if (part.type !== 'ParameterExpansion') continue;
          // A backslash in them escapes only what it escapes in double quotes; before anything else it's gone too.
          const bare = part.text.replaceAll(/\\[\s\S]|\$?"((?:\\[\s\S]|[^"\\])*)"/g, (m, inner?: string) =>
            inner === undefined ? m : inner.replaceAll(/\\([^$`"\\\n])/g, '$1'),
          );
          if ((bare.match(expansion)?.length ?? 0) > (part.text.match(expansion)?.length ?? 0))
            this.expansions(bare, state, ctx, this.at(ctx, state, part), 'parameter', true);
          // And `$'…'` in it stands for what it decodes to, which is expanded: `"${x:-$'\x24(ls)'}"` runs `ls`.
          const decoded = decodeAnsiC(part.text);
          if (decoded !== part.text && /[$`]/.test(decoded.slice(1)))
            this.expansions(decoded, state, ctx, this.at(ctx, state, part), 'parameter', true);
        }
      }
      if (node.type === 'Word' && bracesDisagree(node)) {
        // Bash expands braces on the word's text first: they may make several of a substitution the parser read once.
        const where = this.span(ctx, node.pos, node.end);
        this.finding(ctx, 'parse-error', 'Braces Bash expands differently from the parser', where);
      }
      if ((node.type === 'Word' || node.type === 'Assignment') && ctx.source[node.end] === '#') {
        // `x=<(sort s)#; cat $x`: one word to Bash, as a `#` inside one starts no comment. The parser cut the line there.
        const where = this.span(ctx, node.pos, node.end + 1);
        this.finding(ctx, 'parse-error', 'A `#` inside a word, which the parser read as starting a comment', where);
      }
      if (node.type === 'Word' && !node.parts && /['"`]|\$[({\w@*#?$!-]/.test(node.text)) {
        // `ls[ $(cat q) ]''`: one word to Bash, which expands what's in it. The parser kept it all as plain text.
        const where = this.span(ctx, node.pos, node.end);
        this.finding(ctx, 'parse-error', 'A word with quotes or expansions the parser read as plain text', where);
      }
      if ((node.type === 'Literal' || (node.type === 'Word' && !node.parts)) && /\$\\\n/.test(node.text)) {
        const where = this.span(ctx, node.pos, node.end);
        this.finding(ctx, 'parse-error', 'A `$` before a line continuation, which Bash joins to what follows', where);
      }
      if (unterminated(node)) this.finding(ctx, 'parse-error', "An expansion that's never closed", this.span(ctx, node.pos, node.end));
      if (ctx.quoted && node.type === 'ParameterExpansion' && node.text.includes("$'")) {
        // `"$(echo ${y:-$'\x24(ls)'})"`: the `$'…'` is decoded, then what it holds is expanded, as in double quotes.
        const decoded = decodeAnsiC(node.text);
        if (decoded !== node.text) this.expansions(decoded, state, ctx, this.at(ctx, state, node), 'parameter', true);
      }
      if (node.type === 'ParameterExpansion' && node.operation?.type === 'Unknown')
        this.finding(ctx, 'parse-error', `An expansion the parser couldn't read: ${node.text}`, this.span(ctx, node.pos, node.end));
      if (node.type === 'ParameterExpansion' && node.operation?.type === 'Default' && /^:?=$/.test(node.operation.operator)) {
        // `${x:=v}` assigns x when it's unset (or empty); `${!x:=v}` the variable x names.
        const call = this.at(ctx, state, node);
        if (node.prefix === '!') this.anyVariable(state, ctx, call, `${node.text} assigns a variable named only at run time`);
        else if (/^[A-Za-z_]\w*$/.test(node.parameter))
          state.vars.set(node.parameter, this.assigned(node.parameter, { kind: 'dynamic' }, state, ctx, call, true));
      }
      if (node.type === 'ParameterExpansion') {
        if (node.index && node.index.value !== '@' && node.index.value !== '*') this.arithmeticWord(node.index, state, ctx, true);
        if (node.operation?.type === 'Slice') {
          this.arithmeticWord(node.operation.offset, state, ctx, true);
          if (node.operation.length) this.arithmeticWord(node.operation.length, state, ctx, true);
        }
        this.indirection(node, state, ctx);
      }
      if (
        node.type === 'Word' &&
        (node.parts?.filter((part) => part.type === 'Literal') ?? [node]).some((part) => /[<>]\(/.test(part.text))
      ) {
        // `2>(…)`: one word to Bash, with a process substitution after the digits. The parser read it as plain text.
        const span = this.span(ctx, node.pos, node.end);
        this.finding(ctx, 'parse-error', 'A process substitution after other text in a word, which the parser read as text', span);
        const source = `: ${node.text.slice(node.text.search(/[<>]\(/))}`;
        const inner = { ...ctx, source, outer: span, nesting: [...ctx.nesting, '<(…)'], depth: ctx.depth + 1, concurrent: true };
        if (ctx.depth < this.maxDepth) this.substitutions(this.parse(source).commands, state, inner);
      }
      if (node.type === 'Assignment' && node.value.type === 'Word' && !node.value.parts && /^\(.*[$`<>]/s.test(node.value.text)) {
        // `v=(…)x`: no array, but a string Bash expands, parentheses and all. The parser read it as plain text.
        const where = this.span(ctx, node.pos, node.end);
        this.finding(ctx, 'parse-error', 'An array assignment with text after it, which Bash expands as a string', where);
      }
      if (
        (node.type === 'Redirect' || node.type === 'HereString' || node.type === 'HereDoc') &&
        node.descriptor?.type === 'FileDescriptorVariable'
      ) {
        // `exec {fd}>f` assigns fd the descriptor's number.
        const variable = node.descriptor.name;
        state.vars.set(variable, this.assigned(variable, { kind: 'dynamic', numeric: true }, state, ctx, this.at(ctx, state, node), true));
      }
      if (node.type === 'Assignment' && node.index) this.arithmeticWord(node.index, state, ctx, true);
      if (node.type === 'Assignment' && node.value.type === 'ArrayValue') {
        // `a=([i]=v)`: the subscript is arithmetic, as in `a[i]=v`.
        for (const element of node.value.elements) {
          if (!element.text.startsWith('[')) continue;
          const end = subscriptEnd(element.text);
          if (end === -1) {
            // `[a[1]=1); …]=2`: Bash reads on to the `]` that closes the first, past where the parser ended the element.
            const where = this.span(ctx, element.pos, element.end);
            this.finding(ctx, 'parse-error', "A subscript whose brackets don't close where the parser ended it", where);
            continue;
          }
          if (!/^\]\+?=/.test(element.text.slice(end))) continue;
          const subscript = element.text.slice(1, end);
          this.unquoted(subscript, state, ctx, element);
          // Bash expands the subscript, then expands what that leaves again: `['$'('ls')]=1` runs `ls`, and so does
          // `[$k]=1` with `k='$(ls)'`. What it leaves may be any code when it's only known at run time.
          const call = this.at(ctx, state, element);
          const bare = unquote(subscript);
          if (bare !== subscript && /[$`]/.test(bare)) this.expansions(bare, state, ctx, call, 'subscript');
          const expanded = expandText(subscript, lookupIn(state));
          if (typeof expanded !== 'string' && /[$`]/.test(subscript))
            this.finding(ctx, 'dynamic-script', `An array subscript Bash expands twice is only known at run time: ${subscript}`, call.span);
          else if (typeof expanded === 'string' && expanded !== bare && /[$`]/.test(expanded))
            this.expansions(expanded, state, ctx, call, 'subscript');
          this.arithmeticText(subscript, state, ctx, element.text, this.span(ctx, element.pos, element.end));
        }
      }
      if (node.type === 'TestBinary' && ['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(node.operator)) {
        this.arithmeticWord(node.left, state, ctx);
        this.arithmeticWord(node.right, state, ctx);
      }
      if (node.type === 'TestUnary' && node.operator === '-v') {
        // `[[` neither splits nor globs its operands.
        const value = resolveValue(node.operand, lookupIn(state));
        const arg = value.kind === 'static' ? value : dynamicArg(node.operand.text, 'variable', false, '');
        this.nameWord(arg, state, ctx, this.at(ctx, state, node));
      }
      const inner = node.type === 'HereDocBody' ? { ...ctx, late: true } : ctx;
      // Backquotes are parsed as they run, like a process substitution.
      const backquoted = node.type === 'CommandExpansion' && node.text.startsWith('`');
      forEachChild(node, (child) =>
        visit(child, node.type === 'DoubleQuoted' && child.type === 'CommandExpansion' ? { ...inner, quoted: true } : inner, backquoted),
      );
    };
    for (const node of nodes) visit(node, ctx);
  }

  /**
   * A word Bash evaluates as arithmetic (`[[ x -eq y ]]`, an index, an offset): an expression, after expansion. When it's
   * `expanded` as arithmetic is (not `[[`'s operands), quotes in it quote nothing.
   */
  arithmeticWord(word: Word, state: State, ctx: Context, expanded = false): void {
    if (expanded) this.unquoted(word.text, state, ctx, word);
    const span = this.span(ctx, word.pos, word.end);
    const item = operand(word.value, word.parts, lookupIn(state));
    if (item.kind === 'name') this.arithmeticText(word.value, state, ctx, word.text, span);
    else if (item.kind === 'text') this.arithmeticText(item.text, state, ctx, word.text, span);
    else if (item.kind === 'dynamic')
      this.finding(ctx, 'dynamic-arithmetic', `Arithmetic operand is only known at run time: ${word.text}`, span);
  }

  /**
   * Bash expands arithmetic `text` (`node`'s) as if it were in double quotes, where single quotes are only text:
   * `$(( '$(ls)' ))` runs `ls`, and so does `$(( '$('l's)' ))`. With one in it, all of it is walked as a
   * here-document's body, where they're text too.
   */
  unquoted(text: string, state: State, ctx: Context, node: { pos: number; end: number }): void {
    if (!/['"]/.test(text) || !/[$`]/.test(text)) return;
    if (text.includes("'")) this.expansions(text, state, ctx, this.at(ctx, state, node), 'arithmetic');
    // `$'…'` stands for what it decodes to first: `$'\x24(ls)'` is `$(ls)`.
    const decoded = decodeAnsiC(text);
    if (decoded !== text && /[$`]/.test(decoded)) this.expansions(decoded, state, ctx, this.at(ctx, state, node), 'arithmetic');
    // `$"…"` is translated as Bash parses, and what it leaves with what's around it can't be followed.
    if (text.includes('$"')) this.finding(ctx, 'unknown-syntax', `A $"…" string in arithmetic: ${text}`, this.at(ctx, state, node).span);
    // Double quotes are gone too when a subscript is expanded again: `a[$"$"(ls)]` runs `ls`.
    const expansion = /\$[({\w]|`/g;
    const bare = text.replaceAll(/\\[\s\S]|\$?"((?:\\[\s\S]|[^"\\])*)"/g, (m, inner?: string) => inner ?? m);
    if ((bare.match(expansion)?.length ?? 0) > (text.match(expansion)?.length ?? 0))
      this.expansions(bare, state, ctx, this.at(ctx, state, node), 'arithmetic');
  }

  /**
   * Arithmetic in `text` (a variable's value, a subscript), which Bash parses and evaluates when it gets there. Whether
   * its result is surely a number. `seen` holds the variables being evaluated, to stop at a value that refers to itself.
   */
  arithmeticText(text: string, state: State, ctx: Context, label: string, span: [number, number], seen = new Set<string>()): boolean {
    if (!text.trim()) return true;
    if (seen.size > 32) {
      this.finding(ctx, 'dynamic-arithmetic', `Arithmetic nests deeper than the analysis follows: ${label}`, span);
      return false;
    }
    const script = parse(`(( ${text} ))`);
    const command = script.commands[0]?.command;
    if ((script.errors?.length ?? 0) > 0 || script.commands.length !== 1 || command?.type !== 'ArithmeticCommand' || !command.expression) {
      this.finding(ctx, 'dynamic-arithmetic', `Arithmetic expression is only known at run time: ${label}`, span);
      return false;
    }
    const numeric = this.numericExpression(command.expression, state, seen);
    this.arithmetic(command.expression, state, ctx, seen, span);
    return numeric;
  }

  /**
   * Arithmetic: its operands are evaluated in turn (a variable's value is an expression, and so is a subscript), and its
   * assignments change variables. `span` is where to report what's found in text parsed from elsewhere; without it, the
   * expression is in the source and the substitutions in it run first.
   */
  arithmetic(expression: ArithmeticExpression, state: State, ctx: Context, seen = new Set<string>(), span?: [number, number]): void {
    if (!span) {
      this.substitutions([expression], state, ctx);
      this.unquoted(ctx.source.slice(expression.pos, expression.end), state, ctx, expression);
    }
    const where = (node: SyntaxNode) => span ?? this.span(ctx, node.pos, node.end);
    const lookup = lookupIn(state);
    const reads = new Map<SyntaxNode, boolean>();
    const writes: { variable: string; numeric: boolean }[] = [];
    const visit = (node: SyntaxNode) => {
      if (node.type === 'Script') {
        this.finding(ctx, 'dynamic-arithmetic', 'Arithmetic result depends on a run-time substitution', where(node));
        return;
      }
      const target =
        node.type === 'ArithmeticBinary' && /^([-+*/%&|^]|<<|>>)?=$/.test(node.operator)
          ? node.left
          : node.type === 'ArithmeticUnary' && (node.operator === '++' || node.operator === '--')
            ? node.operand
            : undefined;
      if (target?.type === 'ArithmeticWord') {
        reads.set(target, node.type === 'ArithmeticUnary' || (node.type === 'ArithmeticBinary' && node.operator !== '='));
        // The target is a name once expanded: \`(( $x = 1 ))\` assigns the variable x names.
        const text = /^[A-Za-z_]\w*\[/.test(target.value) ? target.value : expanded(target.value, target.parts, lookup);
        const variable = text === undefined ? undefined : /^([A-Za-z_]\w*)(?:\[[\s\S]*\])?$/.exec(text)?.[1];
        if (variable) {
          writes.push({ variable, numeric: this.numericExpression(expression, state, new Set(seen)) });
        } else {
          this.anyVariable(
            state,
            ctx,
            { ...this.at(ctx, state, expression), span: where(target) },
            `Arithmetic assigns a variable named only at run time: ${target.value}`,
          );
        }
      }
      if (node.type === 'ArithmeticWord')
        return this.operand(node, reads.get(node) ?? true, state, ctx, seen, where(node), span !== undefined);
      forEachChild(node, visit);
    };
    visit(expression);
    for (const { variable, numeric } of writes) {
      const value: Value = { kind: 'dynamic', ...(numeric ? { numeric: true } : {}) };
      state.vars.set(variable, this.assigned(variable, value, state, ctx, this.at(ctx, state, expression), true));
    }
  }

  /**
   * An operand: its subscript is evaluated, and so is the value it reads (`reads`: not the target of a plain `=`). In
   * text from elsewhere (`fromText`: a variable's value), Bash expands the subscript first, and the substitutions in it
   * run: `x='a[$(ls)]'; echo $((x))` runs `ls`. In the source, they were walked with the expression.
   */
  operand(
    word: { value: string; parts?: Word['parts'] },
    reads: boolean,
    state: State,
    ctx: Context,
    seen: Set<string>,
    span: [number, number],
    fromText = false,
  ): void {
    const subscript = /^[^[]*?\[([\s\S]*)\]\}?$/.exec(word.value)?.[1];
    if (subscript !== undefined && subscript !== '@' && subscript !== '*') {
      if (fromText && /[$`]/.test(subscript)) this.expansions(subscript, state, ctx, this.spanned(ctx, state, span), 'subscript');
      this.arithmeticText(subscript, state, ctx, word.value, span, seen);
    }
    if (!reads) return;
    const item = operand(word.value, word.parts, lookupIn(state));
    if (item.kind === 'name') this.arithmeticVariable(item.name, state, ctx, span, seen);
    else if (item.kind === 'text' && item.text !== word.value)
      this.arithmeticText(item.text, state, ctx, word.value, span, new Set([...seen, `\0${seen.size}`]));
    else if (item.kind !== 'number')
      this.finding(ctx, 'dynamic-arithmetic', `Arithmetic operand is only known at run time: ${word.value}`, span);
  }

  /**
   * A variable's name as a builtin reads it (`read`, `printf -v`, `unset`, `test -v`, what `${!x}` refers to): Bash
   * expands a subscript in it, quotes in it quoting nothing, so the substitutions there run, then evaluates it.
   */
  subscript(name: string, state: State, ctx: Context, call: Call): void {
    const subscript = /^[A-Za-z_]\w*\[([\s\S]*)\]$/.exec(name)?.[1];
    if (subscript === undefined || subscript === '@' || subscript === '*') return;
    // With a `'` in it, `unquoted` walks it as a here-document's body, as this would.
    if (/[$`]/.test(subscript) && !subscript.includes("'")) this.expansions(subscript, state, ctx, call, 'subscript');
    this.unquoted(subscript, state, ctx, { pos: call.span[0], end: call.span[1] });
    this.arithmeticText(subscript, state, ctx, name, call.span);
  }

  /** A word Bash reads as a variable's name (`[[ -v x ]]`): one only known at run time may hold any subscript. */
  nameWord(arg: Arg | undefined, state: State, ctx: Context, call: Call): void {
    if (!arg) return;
    if (arg.kind === 'static') return this.subscript(arg.value, state, ctx, call);
    this.finding(ctx, 'dynamic-script', `A variable name only known at run time, whose subscript Bash evaluates: ${arg.text}`, call.span);
  }

  /**
   * `${!x}` reads the variable x names, subscript and all: `x='a[$(ls)]'; echo "${!x}"` runs `ls`. `${x@P}` expands
   * x's value as a prompt string.
   */
  indirection(node: Extract<WordPart, { type: 'ParameterExpansion' }>, state: State, ctx: Context): void {
    const call = this.at(ctx, state, node);
    const lookup = lookupIn(state);
    const value = (name: string, index?: Word): Arg => {
      const known = index ? undefined : lookup(name);
      return known?.kind === 'static' ? { kind: 'static', value: known.value } : dynamicArg(`\${${name}}`, 'variable', false, '');
    };
    const elements = node.index !== undefined && /^[@*]$/.test(node.index.value);
    const indirect = node.prefix === '!' && node.operation?.type !== 'Names' && !elements;
    if (indirect) this.nameWord(value(node.parameter, node.index), state, ctx, call);
    if (node.operation?.type !== 'Transform' || node.operation.operand.value !== 'P') return;
    const target = indirect ? value(node.parameter, node.index) : undefined;
    const text =
      target === undefined
        ? value(node.parameter, node.index)
        : target.kind === 'static' && /^[A-Za-z_]\w*$/.test(target.value)
          ? value(target.value)
          : dynamicArg(node.text, 'variable', false, '');
    if (text.kind === 'static') this.prompt(text.value, state, ctx, call, node.text);
    else this.finding(ctx, 'dynamic-script', `${node.text} expands a prompt string only known at run time`, call.span);
  }

  /**
   * A prompt string: Bash decodes its escapes, then expands it, running the substitutions in it. An escape may make
   * one, or change one: `\044(ls)` runs `ls`, and `$(ls\nid)` runs `id` too.
   */
  prompt(text: string, state: State, ctx: Context, call: Call, label: string): void {
    this.expansions(text, state, ctx, call, label);
    const decoded = decodePrompt(text);
    if (!/[$`]/.test(decoded.text)) return;
    if (decoded.dynamic) this.finding(ctx, 'dynamic-script', `${label} expands an escape whose value is only known at run time`, call.span);
    if (decoded.text !== text) this.expansions(decoded.text, state, ctx, call, label);
  }

  /** A call at `span`, for code found in text from elsewhere. */
  spanned(ctx: Context, state: State, span: [number, number]): Call {
    return { ...this.at(ctx, state, { pos: span[0], end: span[1] }), span };
  }

  /** A variable read in arithmetic: Bash evaluates its value as an expression, recursively. */
  arithmeticVariable(variable: string, state: State, ctx: Context, span: [number, number], seen: Set<string>): void {
    const value = state.vars.get(variable);
    if (!value || numericValue(value)) return;
    if (value.kind === 'dynamic')
      return this.finding(ctx, 'dynamic-arithmetic', `Arithmetic value of \`${variable}\` is only known at run time`, span);
    if (seen.has(variable)) return this.finding(ctx, 'dynamic-arithmetic', `Arithmetic variable \`${variable}\` refers to itself`, span);
    this.arithmeticText(value.value, state, ctx, variable, span, new Set([...seen, variable]));
  }

  /** Whether `expression` surely evaluates to a number, with the values variables hold now. */
  numericExpression(expression: ArithmeticExpression, state: State, seen: Set<string>): boolean {
    const lookup = lookupIn(state);
    const nested = (text: string, next: Set<string>) => {
      if (next.size > 32) return false;
      const script = parse(`(( ${text} ))`);
      const command = script.commands[0]?.command;
      return (
        (script.errors?.length ?? 0) === 0 &&
        command?.type === 'ArithmeticCommand' &&
        !!command.expression &&
        this.numericExpression(command.expression, state, next)
      );
    };
    const value = (name: string): boolean => {
      const current = state.vars.get(name);
      if (!current || numericValue(current)) return true;
      if (current.kind === 'dynamic' || seen.has(name)) return false;
      return !current.value.trim() || nested(current.value, new Set([...seen, name]));
    };
    const plainTargets = new Set<SyntaxNode>();
    let numeric = true;
    const visit = (node: SyntaxNode) => {
      if (!numeric) return;
      if (node.type === 'Script' || node.type === 'ArithmeticCommandExpansion') {
        numeric = false;
        return;
      }
      if (node.type === 'ArithmeticBinary' && node.operator === '=') plainTargets.add(node.left);
      if (node.type === 'ArithmeticWord') {
        if (plainTargets.has(node)) return;
        const item = operand(node.value, node.parts, lookup);
        if (item.kind === 'name') numeric = value(item.name);
        else if (item.kind === 'text') numeric = nested(item.text, new Set([...seen, `\0${seen.size}`]));
        else if (item.kind === 'dynamic') numeric = false;
        return;
      }
      forEachChild(node, visit);
    };
    visit(expression);
    return numeric;
  }

  simple(parsed: Command, state: State, ctx: Context): void {
    const command = rejoined(parsed);
    this.substitutions([command], state, ctx);
    const lookup = lookupIn(state);
    const assignments = command.prefix.filter((item): item is Assignment => item.type === 'Assignment');
    const files = redirections(command.redirects, lookup, this.outputsRead);
    const span = this.span(ctx, command.pos, command.end);
    const argv = command.name ? [...resolveWord(command.name, lookup), ...command.suffix.flatMap((item) => argument(item, lookup))] : [];
    const call: Call = {
      span,
      writes: files.writes,
      reads: files.reads,
      ...(command.name && aliasable(command.name) ? { command } : {}),
      noFunctions: false,
      open: false,
      cwd: state.cwd,
      home: homeOf(state),
    };
    const before = new Map(assignments.map(({ name }) => [name, state.vars.get(name)]));
    // Before a command, they're its temporary environment: a function or builtin sees them as variables, and a local
    // of the same name starts with the value (see `Context.temporary`).
    const temporary = new Map<string, Value>();
    for (const assignment of assignments) {
      const value = tildeExpanded(
        assignmentValue(assignment, lookup),
        'text' in assignment.value ? assignment.value.text : undefined,
        state,
        true,
      );
      const stored = this.assigned(assignment.name, value, state, ctx, call, argv.length === 0);
      state.vars.set(assignment.name, stored);
      temporary.set(assignment.name, stored);
      // Bash is in POSIX mode while the command runs, and after it too when it's a special builtin, which keeps the
      // variable.
      if (argv.length > 0 && assignment.name === 'POSIXLY_CORRECT') maybePosix(state, true);
      // With `set -x`, Bash expands PS4 to trace each assignment, and the command after them with them in place.
      this.between(state, ctx);
    }
    // With no command, Bash assigns first and then redirects, with the new values (`x=/tmp >$x/f`).
    if (argv.length === 0 && assignments.length > 0) {
      const after = redirections(command.redirects, lookupIn(state), this.outputsRead);
      call.writes = after.writes;
      call.reads = after.reads;
    }
    this.wrote(call.writes, call, 'contents');
    const opens = call.writes.length > 0 || call.reads.length > 0;
    const stays = new Map<string, boolean>();
    const inner =
      argv.length > 0 && temporary.size > 0
        ? {
            ...ctx,
            temporary: new Set([...(ctx.temporary ?? []), ...temporary.keys()]),
            kept: { depth: ctx.depth, calls: ctx.calls, names: stays },
          }
        : ctx;
    // A file Bash can't open stops the command before it runs, along with what it would change (`alias x=y <nofile`).
    if (argv.length > 0 && opens) settle(state, [clone(state), this.branch(state, inner, (s, c) => this.dispatch(argv, s, c, call))]);
    else if (argv.length > 0) this.dispatch(argv, state, inner, call);
    if (argv.length > 0) {
      // Gone after it: what was there before is back, unless POSIX mode keeps them (after a special builtin). What a
      // builtin or function assigned to one of them (`z=a declare z=b`) is gone too, unless it went global
      // (`declare -g`, `export`): the value is only known at run time.
      for (const name of stays.keys()) if (!temporary.has(name)) ctx.kept?.names.set(name, false);
      for (const [name, value] of temporary) {
        // Exported or read-only, it stays with its value, unless a file Bash couldn't open stopped the command.
        const stay = stays.get(name);
        if (stay !== undefined) {
          if (opens || !stay) state.vars.set(name, { kind: 'dynamic' });
          continue;
        }
        const back = before.get(name);
        const kept = state.posix === false ? back : back && sameValue(back, value) ? back : { kind: 'dynamic' as const };
        if (!sameValue(state.vars.get(name), value)) state.vars.set(name, { kind: 'dynamic' });
        else if (kept) state.vars.set(name, kept);
        else state.vars.delete(name);
      }
      return;
    }
    if (opens) this.emit(ctx, call, ':', 'builtin', [{ kind: 'static', value: ':' }], emptyParsed());
  }

  /** Runs `argv` as the shell would: an alias, a function, a builtin, or a program. */
  dispatch(argv: Arg[], state: State, ctx: Context, call: Call): void {
    const [head] = argv;
    if (!head) return;
    if (ctx.depth > this.maxDepth) return this.finding(ctx, 'too-deep', 'Commands nest deeper than the analysis follows', call.span);
    if (head.kind === 'dynamic') {
      this.finding(ctx, 'dynamic-command', `The command name is only known at run time: ${head.text}`, call.span);
      const parsed = emptyParsed();
      parsed.positionals = this.withAppended(argv.slice(1), ctx, call);
      parsed.maybeOptions = true;
      this.emit(ctx, call, null, 'external', argv, parsed);
      // A word that expands to nothing leaves the next one as the command, past alias expansion.
      if (head.split && head.prefix === '' && argv.length > 1) {
        settle(state, [
          clone(state),
          this.branch(state, ctx, (s, c) => this.dispatch(argv.slice(1), s, c, { ...call, command: undefined })),
        ]);
      }
      return;
    }
    const name = head.value;
    // Bash looks a command word up as an alias as it's written, braces and all, and not after an assignment and then a
    // redirection (`x=1 >f rm`).
    const command = call.command && !assignedThenRedirected(call.command) ? call.command : undefined;
    if (command && !ctx.externalOnly && ctx.aliases.expand !== false && this.alias(aliasName(command.name!), argv, state, ctx, call))
      return;
    const defined = ctx.externalOnly || call.noFunctions ? undefined : state.functions.get(name);
    // In POSIX mode, a special builtin is found before a function: one that may be in it may run either.
    const special = specialBuiltins.has(name) && !state.disabled.has(name) && state.posix !== false;
    const fn = defined && special && state.posix === true ? undefined : defined && special ? { ...defined, maybeUndefined: true } : defined;
    if (fn) {
      this.emit(ctx, call, name, 'function', argv, emptyParsed());
      const outcomes = fn.bodies.map(({ node, aliases, source, outer }) => {
        if (ctx.calls.includes(node)) {
          this.finding(ctx, 'too-deep', `Recursive function \`${name}\` cannot be followed further`, call.span);
          return clone(state);
        }
        // The body was parsed, aliases and all, when it was defined.
        const returns: State[] = [];
        // A loop around the call is out of reach of a `break` in the body.
        const inner = { ...ctx, source, outer, calls: [...ctx.calls, node], aliases, expanding: [], loops: [], returns };
        return this.branch(state, inner, (s, c) => {
          s.frames = [...s.frames, { locals: new Set(), outer: new Map(), unknown: new Set() }];
          this.node(node.body, s, c);
          for (const other of returns) join(s, other);
          restore(s, state);
        });
      });
      settle(state, fn.maybeUndefined ? [...outcomes, clone(state)] : outcomes);
      if (!fn.maybeUndefined) return;
    }
    if (!ctx.externalOnly && builtins.has(name) && !state.disabled.has(name)) return this.builtin(name, argv, state, ctx, call);
    if (!ctx.externalOnly && !name.includes('/')) this.notFound(argv, state, ctx, call);
    this.program(argv, state, ctx, call);
  }

  /**
   * The program may not be found, and Bash then calls `command_not_found_handle` with the command line, in a subshell.
   * Not `exec`, nor a wrapper (`env`), which look programs up themselves.
   */
  notFound(argv: Arg[], state: State, ctx: Context, call: Call): void {
    const name = 'command_not_found_handle';
    const handler = state.functions.get(name);
    if (!handler) return;
    const subshell = clone(state);
    subshell.functions.set(name, { ...handler, maybeUndefined: false });
    this.dispatch([{ kind: 'static', value: name }, ...argv], subshell, ctx, { ...call, command: undefined, noFunctions: false });
  }

  /**
   * Expands an alias in place of the command word; `true` when that's all that runs. When aliases may be on or off,
   * both ways are walked.
   */
  alias(name: string, argv: Arg[], state: State, ctx: Context, call: Call): boolean {
    const { table, unknown, expand } = ctx.aliases;
    const at = call.command?.name?.pos;
    if (!table.has(name) || (at === undefined ? ctx.expanding.some((alias) => alias.name === name) : active(ctx, at).includes(name))) {
      if (unknown) this.finding(ctx, 'unknown-alias', `\`${name}\` may be an alias defined at run time`, call.span);
      return false;
    }
    const { value, maybe } = table.get(name)!;
    if (value === undefined) {
      this.finding(ctx, 'unknown-alias', `\`${name}\` is an alias whose value is only known at run time`, call.span);
      return false;
    }
    const expanded = (s: State, c: Context) => this.expandAlias(name, value, call.command!, s, c, call);
    if (expand && !maybe) {
      expanded(state, ctx);
    } else {
      settle(state, [
        this.branch(state, ctx, expanded),
        this.branch(state, ctx, (s, c) => this.dispatch(argv, s, c, { ...call, command: undefined })),
      ]);
    }
    return true;
  }

  /**
   * Bash puts an alias's text in place of the command word and parses the command again. When the text ends in a
   * blank, the next word is expanded too if it's an alias.
   */
  expandAlias(name: string, value: string, command: Command, state: State, ctx: Context, call: Call): void {
    if (ctx.depth >= this.maxDepth)
      return this.finding(ctx, 'too-deep', `Aliases nest deeper than the analysis follows (${name})`, call.span);
    const head = ctx.source.slice(command.pos, command.name!.pos);
    let text = head + value;
    // What was put in place of a word, by where it was and where its text is now: an alias whose text the word started
    // in is still being read through all of it.
    const replaced = [{ from: command.name!.pos, to: command.name!.end, start: head.length, end: text.length }];
    const expanding: Expanding[] = [{ name, end: text.length }];
    let rest = command.name!.end;
    let check = /[ \t]$/.test(value);
    const values = [value];
    for (const item of command.suffix) {
      // A quoted word isn't expanded, and the next one is still checked; one with an unquoted expansion ends it.
      if (item.type === 'Word' && item.parts?.some((part) => aliasStoppers.has(part.type))) break;
      if (item.type === 'Word' && !aliasable(item)) continue;
      if (!check || item.type !== 'Word') break;
      const words = this.aliasWord(aliasName(item), active(ctx, item.pos), ctx, call);
      if (!words) break;
      text += ctx.source.slice(rest, item.pos);
      const start = text.length;
      text += words.text;
      replaced.push({ from: item.pos, to: item.end, start, end: text.length });
      expanding.push(...words.expanding.map((alias) => ({ name: alias.name, end: start + alias.end })));
      rest = item.end;
      check = words.check;
      values.push(words.text);
    }
    const tail = text.length;
    text += ctx.source.slice(rest, command.end);
    // An alias whose text the command word started in is read through what replaced it, and up to its end after that.
    for (const outer of ctx.expanding) {
      if (outer.end <= command.name!.pos) continue;
      const ends = replaced.filter((piece) => piece.from < outer.end).map((piece) => piece.end);
      if (outer.end > rest) ends.push(tail + Math.min(outer.end, command.end) - rest);
      expanding.push({ name: outer.name, end: Math.max(...ends) });
    }
    const inner = {
      ...ctx,
      source: text,
      outer: call.span,
      nesting: [...ctx.nesting, `alias ${name}`],
      depth: ctx.depth + 1,
      expanding,
    };
    // A here-document the alias's text opens has the lines after the command as its body, which the parser read as
    // commands: a `<<` among them can hide the rest of the script.
    if (values.some((text) => unclosed(this.parse(text))))
      this.finding(ctx, 'parse-error', `An alias opens a here-document, whose body the parser read as commands`, call.span);
    this.script(this.parse(text), state, inner, ctx.aliases);
  }

  /**
   * The text Bash reads for `word` where it checks a word that isn't the command's for an alias (after one whose text
   * ends in a blank): the alias's text, read a word at a time. While Bash checks the next word, each that's an alias
   * not among `reading` (those whose text it's in) is replaced too; a word that isn't ends the checking, and the end of
   * a text that ends in a blank starts it again. `check`: whether the word after it is checked. `undefined` when
   * `word` is no alias, or one the analysis can't follow (a finding).
   */
  aliasWord(
    word: string,
    reading: string[],
    ctx: Context,
    call: Call,
  ): { text: string; check: boolean; expanding: Expanding[] } | undefined {
    const { table, unknown } = ctx.aliases;
    if (!table.has(word) || reading.includes(word)) {
      if (!table.has(word) && unknown) this.finding(ctx, 'unknown-alias', `\`${word}\` may be an alias defined at run time`, call.span);
      return undefined;
    }
    const { value, maybe } = table.get(word)!;
    if (value === undefined || maybe) {
      this.finding(ctx, 'unknown-alias', `\`${word}\` may be an alias, or one whose value is only known at run time`, call.span);
      return undefined;
    }
    if (reading.length > this.maxDepth) {
      this.finding(ctx, 'too-deep', `Aliases nest deeper than the analysis follows (${word})`, call.span);
      return undefined;
    }
    // Its own words: the first command's, as an operator after them puts the next in a command word's place, which
    // the command parsed again checks.
    const first = this.parse(value).commands[0]?.command;
    const words =
      first?.type === 'Command'
        ? [...first.prefix, ...(first.name ? [first.name] : []), ...first.suffix].toSorted((a, b) => a.pos - b.pos)
        : [];
    let text = '';
    let rest = 0;
    let check = true;
    const expanding: Expanding[] = [];
    for (const item of words) {
      if (item.type === 'Word' && item.parts?.some((part) => aliasStoppers.has(part.type))) {
        check = false;
        break;
      }
      if (item.type === 'Word' && !aliasable(item)) continue;
      if (!check) break;
      const inner = item.type === 'Word' ? this.aliasWord(aliasName(item), [...reading, word], ctx, call) : undefined;
      if (!inner) {
        check = false;
        break;
      }
      text += value.slice(rest, item.pos);
      const start = text.length;
      text += inner.text;
      expanding.push(...inner.expanding.map((alias) => ({ name: alias.name, end: start + alias.end })));
      rest = item.end;
      check = inner.check;
    }
    text += value.slice(rest);
    expanding.push({ name: word, end: text.length });
    return { text, check: check || /[ \t]$/.test(value), expanding };
  }

  builtin(name: string, argv: Arg[], state: State, ctx: Context, call: Call): void {
    const args = argv.slice(1);
    const values = args.map((arg) => (arg.kind === 'static' ? arg.value : undefined));
    const effects: Effect[] = [];
    const historyWrites: Arg[] = [];
    switch (name) {
      case 'command': {
        let i = 0;
        let lookupOnly = false;
        for (; i < args.length && values[i]?.startsWith('-') && values[i] !== '-'; i++) {
          if (values[i] === '--') {
            i++;
            break;
          }
          if (/[vV]/.test(values[i]!)) lookupOnly = true;
        }
        if (!lookupOnly && i < args.length)
          return this.dispatch(args.slice(i), state, ctx, { ...call, command: undefined, noFunctions: true });
        break;
      }
      case 'builtin': {
        const rest = values[0] === '--' ? args.slice(1) : args;
        const target = rest[0]?.kind === 'static' ? rest[0].value : undefined;
        if (target && builtins.has(target)) return this.builtin(target, rest, state, ctx, call);
        break;
      }
      case 'exec': {
        // `-a name` and `-l` (`-name`) start the program under another name, which some act on (`pgrep` as `pkill`,
        // `git` as `git-branch`): what it does is then only known at run time.
        const { options, rest, dynamic, bad } = getopt(values, 'cla:');
        if (bad) break;
        const command = values[rest];
        const named = options.find(([letter]) => letter === 'a')?.[1];
        const renamed =
          dynamic ||
          options.some(([letter]) => letter === 'l') ||
          (options.some(([letter]) => letter === 'a') &&
            (named === undefined || command === undefined || basename(named) !== basename(command)));
        if (renamed && rest < args.length)
          this.finding(ctx, 'loads-code', 'exec starts a program under another name, which it may act on', call.span);
        if (rest < args.length)
          return this.dispatch(args.slice(rest), state, { ...ctx, externalOnly: true }, { ...call, command: undefined });
        break;
      }
      case 'eval': {
        const text = joinStatic(values[0] === '--' ? args.slice(1) : args);
        if (text === undefined) this.finding(ctx, 'dynamic-script', 'eval runs a string only known at run time', call.span);
        else this.code(text, state, ctx, call, 'eval');
        return;
      }
      case '.':
      case 'source':
        // What it runs isn't seen, nor where it leaves the shell.
        effects.push('exec:file');
        state.cwd = undefined;
        state.failedCwd = undefined;
        break;
      case 'break':
      case 'continue': {
        // `break n` leaves n loops (all, past the outermost); one Bash refuses (`break 0`) or only known at run
        // time may leave any of them.
        const count = values.length === 0 ? 1 : values.length === 1 && /^\d+$/.test(values[0] ?? '') ? Number(values[0]) : 0;
        const targets = count > 0 ? [ctx.loops[Math.max(0, ctx.loops.length - count)]] : ctx.loops;
        for (const jumps of targets) if (jumps) (name === 'break' ? jumps.breaks : jumps.continues).push(clone(state));
        break;
      }
      case 'return':
        ctx.returns?.push(clone(state));
        break;
      case 'trap': {
        // `-l`, `-p` and `-P` print; `-` (an action) resets.
        if (values[0] !== '-' && values[0] !== '--' && values[0]?.startsWith('-')) break;
        const [action, ...signals] = values[0] === '--' ? args.slice(1) : args;
        // One argument resets that signal.
        if (!action || signals.length === 0) break;
        // A signal only known at run time is a slot nothing else resets.
        const slots = signals.map(
          (signal, i) => `trap:${signal.kind === 'static' ? signalName(signal.value) : `${call.span.join()}:${i}`}`,
        );
        if (action.kind === 'dynamic') {
          this.finding(ctx, 'dynamic-script', 'trap runs a string only known at run time', call.span);
        } else if (action.value === '' || action.value === '-') {
          for (const slot of slots) state.later.delete(slot);
        } else {
          const text = action.value;
          this.later(state, slots, 'trap', text, call, (s, silent) => this.code(text, s, { ...ctx, silent }, call, 'trap'));
        }
        break;
      }
      case 'alias': {
        effects.push('shell-state');
        // Options as getopt reads them: one Bash doesn't know defines nothing. After them, `-x=y` is a name too.
        const { rest, dynamic, bad } = getopt(values, 'p');
        if (dynamic) state.aliasesUnknown = true;
        if (dynamic || bad) break;
        for (const arg of args.slice(rest)) {
          if (arg.kind === 'dynamic') {
            state.aliasesUnknown = true;
            continue;
          }
          const equals = arg.value.indexOf('=');
          // A name with `/`, an expansion, a quote or a metacharacter is one Bash refuses.
          if (equals <= 0 || /[/$`'"\\\s()<>;&|]/.test(arg.value.slice(0, equals))) continue;
          const name = arg.value.slice(0, equals);
          // Bash expands one named after a reserved word where that word starts a command (`fi`, `{`, `do`), which the
          // analysis, reading the parsed syntax, doesn't.
          if (reservedWords.has(name))
            this.finding(ctx, 'unknown-syntax', `An alias named after the reserved word \`${name}\` changes how code is read`, call.span);
          state.aliases.set(name, { value: arg.value.slice(equals + 1), maybe: false });
        }
        break;
      }
      case 'unalias': {
        effects.push('shell-state');
        const { options, rest, dynamic, bad } = getopt(values, 'a');
        // A name only known at run time may be any of them.
        if (dynamic || values.slice(rest).includes(undefined))
          for (const [name, alias] of state.aliases) state.aliases.set(name, { ...alias, maybe: true });
        if (dynamic || bad) break;
        if (options.length > 0) state.aliases.clear();
        for (const value of values.slice(rest)) if (value !== undefined) state.aliases.delete(value);
        break;
      }
      case 'shopt': {
        if (args.some((arg) => arg.kind === 'dynamic')) {
          this.anyOption(state, ctx, call);
          break;
        }
        // Options as getopt reads them (a lone - is a name); a bad one, or -s with -u, changes nothing. With -o, the
        // names are `set -o`'s.
        const { options, rest, bad } = getopt(values, 'psuoq');
        const flags = options.map(([letter]) => letter).join('');
        if (bad || (flags.includes('s') && flags.includes('u'))) break;
        if (!flags.includes('s') && !flags.includes('u')) break;
        for (const name of values.slice(rest))
          this.shellOption(flags.includes('o') ? 'set' : 'shopt', name!, flags.includes('s'), true, state, ctx, call);
        break;
      }
      case 'set':
        this.set(values, state, ctx, call);
        break;
      case 'hash':
        effects.push('shell-state');
        this.hash(values, state, ctx, call);
        break;
      case 'enable': {
        effects.push('shell-state');
        const { options, rest, dynamic, bad } = getopt(values, 'adnpsf:');
        if (bad) break;
        if (options.some(([letter]) => letter === 'f')) {
          effects.push('exec:file');
          this.finding(ctx, 'loads-code', '`enable -f` loads a builtin from a shared object', call.span);
        }
        const names = values.slice(rest);
        // A word only known at run time may be -n, or the name of any builtin, which then runs a program instead.
        if (dynamic || names.includes(undefined))
          this.finding(ctx, 'dynamic-command', '`enable` has arguments only known at run time: a builtin may run a program', call.span);

        const disabling = options.some(([letter]) => letter === 'n');
        // -p only prints, and -d removes only a builtin -f loaded: neither turns one on or off.
        if (options.some(([letter]) => letter === 'p' || letter === 'd')) break;
        for (const value of names) {
          if (value === undefined || !builtins.has(value)) continue;
          if (disabling) state.disabled.add(value);
          else state.disabled.delete(value);
        }
        break;
      }
      case 'cd':
      case 'pushd': {
        if (name === 'pushd') {
          // -n only changes the stack. With no directory it swaps the top two, and `+N` or `-N` rotates it: both go
          // to a directory from earlier, which the analysis doesn't keep.
          const end = values.indexOf('--');
          const options = end === -1 ? values : values.slice(0, end);
          if (options.includes('-n')) break;
          const operands = end === -1 ? values : values.slice(end + 1);
          const rotates = end === -1 && operands.some((value) => value !== undefined && /^[+-]\d+$/.test(value));
          if (operands.length === 0 || rotates) {
            state.failedCwd = { cwd: state.cwd };
            state.cwd = undefined;
            break;
          }
        }
        const at = values.findIndex((value) => value === undefined || !value.startsWith('-') || value === '-' || value === '--');
        const index = values[at] === '--' ? at + 1 : at;
        const target = index === -1 ? undefined : values[index];
        const arg = index === -1 ? undefined : args[index];
        // Physically (-P, `set -P`; the last of -L and -P counts), the directory is where symlinks lead, and `..` leaves
        // that, not the symlink; with cdable_vars, a name that's no directory is a variable holding one.
        const letters = (at === -1 ? values : values.slice(0, at)).join('').replace(/[^LP]/g, '');
        const physical = letters === '' ? option(state, 'physical') : letters.endsWith('P');
        const elsewhere =
          arg?.kind === 'static' &&
          ((physical !== false && arg.value.split('/').includes('..')) ||
            (option(state, 'cdable_vars') !== false && /^[A-Za-z_]\w*$/.test(arg.value)));
        // It fails on a directory that isn't there, and the shell stays where it was. Through a nameref, setting PWD or
        // OLDPWD may fail after it moved.
        const named = state.refs.has('PWD') || state.refs.has('OLDPWD');
        const from = state.cwd;
        state.failedCwd = { cwd: named ? undefined : from };
        const logical =
          index === -1
            ? (homeOf(state) ?? '~')
            : arg?.kind === 'static' && target !== '-' && !elsewhere
              ? resolvePath(state.cwd, arg.value, homeOf(state))
              : undefined;
        // Where symlinks lead is known from the files, if at all.
        const real =
          physical === false || logical === undefined ? logical : logical.startsWith('/') ? this.files?.physical(logical) : undefined;
        state.cwd = physical === undefined && real !== logical ? undefined : real;
        // Logically, a `..` path that isn't there is tried again as the kernel reads it: up from where a symlink leads.
        const given = arg?.kind === 'static' ? arg.value : undefined;
        if (physical === false && given?.split('/').includes('..') && this.files && logical?.startsWith('/')) {
          const there = this.files.realpath(logical);
          if (there === null) state.cwd = this.openedPath(from, given, homeOf(state));
          else if (there === undefined) state.cwd = undefined;
        }
        break;
      }
      case 'popd':
        state.cwd = undefined;
        break;
      case 'declare':
      case 'typeset':
      case 'local':
      case 'export':
      case 'readonly': {
        // Outside a function, `local` is an error that changes nothing.
        if (name === 'local' && ctx.calls.length === 0) break;
        // Options end at the first name, as getopt reads them, and one Bash doesn't know changes nothing.
        const end = values.findIndex((value) => value === undefined || value === '--' || !/^[-+]./.test(value));
        const options = end === -1 ? values : values.slice(0, end);
        const known = name === 'export' || name === 'readonly' ? /^[-+][aAfnp]+$/ : /^[-+][aAfFgiIlnprtuxc]+$/;
        if (!options.every((option) => known.test(option!))) break;
        const unknown = end === -1 ? undefined : args[end];
        if (unknown?.kind === 'dynamic' && /^([-+]|$)/.test(unknown.prefix)) {
          // A word only known at run time that may be an option: one Bash rejects changes nothing, another gives the
          // names after it any attribute (a nameref, an integer, a case). It may be a name and value itself, of any
          // variable, and unquoted, several words: options and names, all unseen.
          const attributes = `${name} has arguments only known at run time, which may give a variable any attribute`;
          if (unknown.split) this.finding(ctx, 'dynamic-script', attributes, call.span);
          // It may be `-`, which saves the options.
          if (name === 'local') saveOptions(state, true);
          this.anyVariable(state, ctx, call, `${name} may set a variable named only at run time`);
          for (const arg of args.slice(end + 1)) {
            const variable = /^[A-Za-z_]\w*/.exec(arg.kind === 'static' ? arg.value : arg.prefix)?.[0];
            if (!variable) continue;
            unknownVariable(state, variable);
            state.refs.add(variable);
          }
          break;
        }
        const flags = options.filter((value) => value?.startsWith('-')).join('');
        const off = options.filter((value) => value?.startsWith('+')).join('');
        // What a later assignment or `unset` does to one (nothing, past an error) isn't followed.
        if (name === 'readonly' || flags.includes('r'))
          this.finding(ctx, 'sensitive-variable', `${name} makes a name read-only, which later changes leave as it is`, call.span);
        // In a function, `local` and `declare` without -g make a variable of the call's own, unset until assigned.
        const locals = ctx.calls.length > 0 && name !== 'export' && name !== 'readonly' && !flags.includes('g');
        // -p and -F only print: `declare -p x=1` is an error that assigns nothing.
        const prints = /[pF]/.test(flags);
        for (const arg of args) {
          const text = arg.kind === 'static' ? arg.value : arg.prefix;
          // `local -` saves the `set` options, which the return puts back.
          if (name === 'local' && arg.kind === 'static' && text === '-') saveOptions(state, false);
          if (text.startsWith('-')) continue;
          // `declare 'a[$(ls)]=1'` runs `ls`: the subscript is expanded, then evaluated.
          const open = arg.kind === 'static' ? /^[A-Za-z_]\w*\[/.exec(text)?.[0].length : undefined;
          const close = open === undefined ? -1 : subscriptEnd(text.slice(open - 1));
          if (open !== undefined && close !== -1) this.subscript(text.slice(0, open + close), state, ctx, call);
          // `y!=d` is no name to Bash, which refuses it and goes on to the next. A word only known at run time names a
          // variable only once `[` or `=` ends the name: before that, it may be any.
          const match =
            arg.kind === 'static'
              ? /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?(\+?=|$)/.exec(text)
              : /^([A-Za-z_][A-Za-z0-9_]*)(\[|\+?=)/.exec(text);
          if (!match && arg.kind === 'static') continue;
          if (!match) {
            this.anyVariable(state, ctx, call, `${name} sets a variable named only at run time`);
            continue;
          }
          const variable = match[1]!;
          if (prints && !flags.includes('f')) {
            if (match[2]) state.vars.set(variable, { kind: 'dynamic' });
            continue;
          }
          if (flags.includes('f')) {
            // `export -f`, `declare -fx`; `export -nf` and `declare +x -f` take it back. One that isn't defined is an
            // error, which exports nothing.
            const fn = state.functions.get(variable);
            if ((name === 'export' && flags.includes('n')) || off.includes('x')) {
              state.exportedFunctions.delete(variable);
              state.maybeExportedFunctions.delete(variable);
            } else if (fn && (name === 'export' || flags.includes('x'))) {
              if (fn.maybeUndefined && !state.exportedFunctions.has(variable)) state.maybeExportedFunctions.add(variable);
              else if (!fn.maybeUndefined) state.maybeExportedFunctions.delete(variable);
              state.exportedFunctions.add(variable);
            }
            continue;
          }
          const frame = state.frames.at(-1);
          if (locals && frame && !frame.locals.has(variable)) {
            // `local PATH` leaves PATH empty in the function: commands are looked up in the working directory.
            if (sensitive.test(variable))
              this.finding(ctx, 'sensitive-variable', `${name} ${variable} unsets it inside the function`, call.span);
            // Maybe local already, it may keep the value it has, and what the return puts back is only known at run time.
            const already = frame.unknown.has(variable);
            if (!already) {
              frame.locals.add(variable);
              frame.outer.set(variable, {
                value: state.vars.get(variable),
                exported: state.exported.has(variable),
                integers: state.integers.has(variable),
                maybeIntegers: state.maybeIntegers.has(variable),
                cased: state.cases.has(variable),
                case: state.cases.get(variable),
              });
            }
            // Unset in the shell, while what it starts still sees an exported value from outside. With
            // localvar_inherit (or -I), it starts with the value and attributes it had outside.
            const inherit = already || ctx.temporary?.has(variable) ? undefined : flags.includes('I') || option(state, 'localvar_inherit');
            const outside = state.vars.get(variable);
            const own: Value = state.exported.has(variable) ? { kind: 'dynamic' } : { kind: 'static', value: '' };
            state.vars.set(variable, inherit === false ? own : inherit && outside ? outside : { kind: 'dynamic' });
            if (inherit === false) state.integers.delete(variable);
            if (inherit === false) state.maybeIntegers.delete(variable);
            else if (inherit === undefined && state.integers.has(variable)) state.maybeIntegers.add(variable);
            if (inherit === false) state.cases.delete(variable);
            else if (inherit === undefined && state.cases.has(variable)) state.cases.set(variable, undefined);
          }
          // `export -n` and `declare +x` take the export away: what's started after doesn't get it.
          if ((name === 'export' && flags.includes('n')) || off.includes('x')) {
            state.exported.delete(variable);
            state.maybeExported.delete(variable);
          } else if (name === 'export' || flags.includes('x')) {
            state.exported.add(variable);
            state.maybeExported.delete(variable);
          }
          const exports = (name === 'export' && !flags.includes('n')) || name === 'readonly' || /[xr]/.test(flags);
          // `declare -g` with a value sets the global under the temporary one, which is what's left after it.
          const global = flags.includes('g') && Boolean(match[2]);
          if ((exports || global) && ctx.temporary?.has(variable))
            ctx.kept?.names.set(variable, ctx.kept.depth === ctx.depth && ctx.kept.calls === ctx.calls);
          if (flags.includes('i')) state.integers.add(variable);
          if (flags.includes('i') || off.includes('i')) state.maybeIntegers.delete(variable);
          if (off.includes('i')) state.integers.delete(variable);
          // One of -u, -l and -c sets it; two of them together, or +u, +l or +c, turn it off.
          const cases = new Set((['u', 'l', 'c'] as const).filter((flag) => flags.includes(flag)));
          if (cases.size === 1) state.cases.set(variable, [...cases][0]);
          else if (cases.size > 1 || options.some((option) => option?.startsWith('+') && /[ulc]/.test(option)))
            state.cases.delete(variable);
          if (flags.includes('n') && name !== 'export' && name !== 'readonly') {
            // A nameref: its value is the name of the variable it stands for, which isn't assigned. (`export -n`
            // takes the export away.) Each read of it reads that variable, subscript and all: `a[$(ls)]` runs `ls`.
            if (match[2])
              this.nameWord(arg.kind === 'static' ? { kind: 'static', value: text.slice(match[0].length) } : arg, state, ctx, call);
            state.refs.add(variable);
            state.vars.set(variable, { kind: 'dynamic' });
            continue;
          }
          // An element (`x[1]=`, or one `export` refuses), an array (-a, -A, which Bash may refuse to convert), and
          // `(…)`, which is a list for an array, aren't followed.
          const assigned = text.slice(match[0].length);
          const written = call.command?.suffix.find((item): item is Word => item.type === 'Word' && item.text.startsWith(match[0]))?.text;
          const value: Value =
            match[2] === '+=' || arg.kind === 'dynamic' || match[0].includes('[') || /[aA]/.test(flags) || assigned.startsWith('(')
              ? { kind: 'dynamic' }
              : tildeExpanded({ kind: 'static', value: assigned }, written?.slice(match[0].length), state, true);
          const stored = match[2] ? this.assigned(variable, value, state, ctx, call, true) : value;
          // -g under a local of the same name changes the global, which the calls that made it local don't put back.
          const shadowed = !locals && flags.includes('g') && state.frames.some((f) => f.locals.has(variable) || f.unknown.has(variable));
          if (shadowed) {
            for (const f of state.frames) if (f.locals.delete(variable) || f.unknown.has(variable)) f.unknown.add(variable);
            state.vars.set(variable, { kind: 'dynamic' });
          } else if (match[2] || value.kind === 'dynamic') {
            state.vars.set(variable, stored);
          }
        }
        break;
      }
      case 'unset': {
        // Options as getopt reads them: a bad one, or -f with -v, unsets nothing. One only known at run time may be
        // any, before names that may be either.
        const { options, rest, dynamic, bad } = getopt(values, 'fnv');
        const letters = options.map(([letter]) => letter).join('');
        if (bad || (letters.includes('f') && letters.includes('v'))) break;
        const functions = !dynamic && letters.includes('f');
        const variablesOnly = !dynamic && letters.includes('v');
        const refsThemselves = letters.includes('n');
        /** Without -v, a name that's no variable is a function's, which Bash removes instead. */
        const maybeFunction = (fn: string) => {
          const known = state.functions.get(fn);
          if (known) state.functions.set(fn, { ...known, maybeUndefined: true });
          // Defined again after, it isn't exported.
          if (state.exportedFunctions.has(fn)) state.maybeExportedFunctions.add(fn);
        };
        for (const value of values.slice(rest)) {
          if (value === undefined) {
            if (!variablesOnly) for (const fn of state.functions.keys()) maybeFunction(fn);
            if (functions) continue;
            if (state.posix !== false) state.posix = undefined;
            if (state.expandAliases !== false) state.expandAliases = undefined;
            this.anyVariable(state, ctx, call, 'unset removes a variable named only at run time');
            continue;
          }
          if (value.startsWith('-')) continue;
          // `unset 'a[$(ls)]'` runs `ls` when a is an array.
          if (!functions) this.subscript(value, state, ctx, call);
          // An element: `x[0]` of a plain variable is all of it, and `x[@]` of an array.
          const element = functions ? undefined : /^([A-Za-z_]\w*)\[/.exec(value)?.[1];
          if (element) {
            if (sensitive.test(element))
              this.finding(ctx, 'sensitive-variable', `Unsetting ${element} changes what runs or how`, call.span);
            if (state.refs.has(element) && !refsThemselves)
              this.anyVariable(state, ctx, call, `${element} may be a nameref: unsetting it unsets another variable`);
            state.vars.set(element, { kind: 'dynamic' });
            continue;
          }
          if (functions) {
            state.functions.delete(value);
            state.exportedFunctions.delete(value);
            state.maybeExportedFunctions.delete(value);
            continue;
          }
          if (!variablesOnly) maybeFunction(value);
          if (refsThemselves) state.refs.delete(value);
          else if (state.refs.has(value))
            this.anyVariable(state, ctx, call, `${value} may be a nameref: unsetting it unsets another variable`);
          if (sensitive.test(value)) this.finding(ctx, 'sensitive-variable', `Unsetting ${value} changes what runs or how`, call.span);
          // In a function, a variable that isn't its own local may be a caller's: unsetting that one shows the value
          // it hid (unless localvar_unset).
          // A caller's local it unsets is gone: an assignment after it lands outside that call, which may then put
          // back nothing.
          const own = state.frames.at(-1);
          const hidden = ctx.calls.length > 0 && !own?.locals.has(value);
          if (hidden) for (const frame of state.frames) if (frame !== own && frame.locals.delete(value)) frame.unknown.add(value);
          if (hidden) {
            unknownVariable(state, value);
          } else {
            state.vars.set(value, { kind: 'static', value: '' });
            // Unset, it isn't exported: assigned again, it's the shell's own.
            state.exported.delete(value);
            state.maybeExported.delete(value);
            state.integers.delete(value);
            state.maybeIntegers.delete(value);
            state.cases.delete(value);
          }
          // Bash leaves POSIX mode, turning expand_aliases off, even when it wasn't in it.
          if (!functions && value === 'POSIXLY_CORRECT') {
            state.posix = false;
            state.expandAliases = false;
          }
        }
        break;
      }
      case 'read':
      case 'getopts':
      case 'mapfile':
      case 'readarray':
      case 'printf':
      case 'wait':
        this.assigns(name, args, state, ctx, call);
        break;
      case 'test':
      case '[':
        // `-v` reads the next word as a variable's name, and a word only known at run time may be `-v`, or both.
        args.forEach((arg, i) => {
          const after = i > 0 && (values[i - 1] === '-v' || args[i - 1]!.kind === 'dynamic');
          if (after || (arg.kind === 'dynamic' && arg.split)) this.nameWord(arg, state, ctx, call);
        });
        break;
      case 'let':
        for (const arg of args) {
          if (arg.kind === 'static') this.arithmeticText(arg.value, state, ctx, arg.value, call.span);
          else this.finding(ctx, 'dynamic-arithmetic', 'let evaluates an arithmetic expression only known at run time', call.span);
        }
        break;
      case 'compgen':
      case 'complete': {
        const { options, dynamic } = getopt(values, 'abcdefgjksuvpDEIo:A:G:W:F:C:X:P:S:V:r');
        if (dynamic)
          this.finding(ctx, 'dynamic-script', `${name} has an option only known at run time, which may be a callback`, call.span);
        for (const [letter, value] of options) {
          if (letter === 'C') this.callback(value, state, ctx, call, name);
          if (letter === 'V' && name === 'compgen') this.setNamed(name, value ?? null, state, ctx, call);
          if (name !== 'compgen') continue;
          // compgen expands -W's word list, substitutions and all, and calls -F's function in the shell itself.
          if (letter === 'W' && value !== undefined) this.expansions(value, state, ctx, call, 'compgen -W');
          if (letter === 'W' && value === undefined)
            this.finding(ctx, 'dynamic-script', 'compgen -W expands a word list only known at run time', call.span);
          if (letter === 'F' && value !== undefined)
            this.dispatch([{ kind: 'static', value }], state, ctx, { ...call, command: undefined });
          if (letter === 'F' && value === undefined)
            this.finding(ctx, 'dynamic-script', 'compgen -F calls a function named only at run time', call.span);
        }
        // compgen -V may be among them, setting any variable.
        if (dynamic && name === 'compgen') this.setNamed(name, null, state, ctx, call);
        break;
      }
      case 'fc': {
        // Without -l, fc runs earlier command lines again (in an editor first, unless -s), which the analysis doesn't see.
        const { options, dynamic } = getopt(values, 'e:lnrs');
        if (dynamic || !options.some(([letter]) => letter === 'l'))
          this.finding(ctx, 'dynamic-script', 'fc runs command lines from the history again', call.span);
        break;
      }
      case 'history': {
        // -a and -w write the history to the file named, or to HISTFILE.
        const { options, rest, dynamic } = getopt(values, 'cd:anrwps');
        if (!dynamic && !options.some(([letter]) => letter === 'a' || letter === 'w')) break;
        const histfile = state.vars.get('HISTFILE');
        const unknown: Arg = { kind: 'dynamic', text: '$HISTFILE', reason: 'variable', split: false, prefix: '' };
        // A clean shell has no HISTFILE, and `history` then writes nothing.
        if (dynamic) historyWrites.push(unknown);
        else if (args[rest]) historyWrites.push(args[rest]);
        else if (histfile?.kind === 'dynamic') historyWrites.push(unknown);
        else if (histfile?.value) historyWrites.push({ kind: 'static', value: histfile.value });
        break;
      }
    }
    const parsed = normalize(this.withAppended(args, ctx, call), specFor(name));
    for (const effect of effects) parsed.effects.add(effect);
    if (name === '.' || name === 'source') parsed.reads.push(...args.slice(0, 1));
    if (historyWrites.length > 0) {
      parsed.writes.push(...historyWrites);
      parsed.effects.add('fs:write');
    }
    this.emit(ctx, call, name, 'builtin', argv, parsed);
    this.wrote(parsed.writes, call, 'contents');
  }

  /**
   * A builtin sets a variable by name to something only known at run time; `null` for a name only known at run time,
   * which may be any variable.
   */
  setNamed(name: string, variable: string | null | undefined, state: State, ctx: Context, call: Call, numeric = false): void {
    if (variable === null) return this.anyVariable(state, ctx, call, `${name} sets a variable named only at run time`);
    if (!variable) return;
    this.subscript(variable, state, ctx, call);
    const base = variable.replace(/\[.*$/, '');
    state.vars.set(base, this.assigned(base, { kind: 'dynamic', ...(numeric ? { numeric } : {}) }, state, ctx, call, true));
  }

  /** Builtins that set variables from input (`read`, `mapfile`, `printf -v`, `wait -p`): those become dynamic. */
  assigns(name: string, args: Arg[], state: State, ctx: Context, call: Call): void {
    const values = args.map((arg) => (arg.kind === 'static' ? arg.value : undefined));
    const set = (variable: string | null | undefined) => this.setNamed(name, variable, state, ctx, call);
    const named = (i: number) => (args[i]?.kind === 'dynamic' ? null : values[i]);
    if (name === 'printf' || name === 'wait') {
      // A word only known at run time may be `-v NAME` (`-vNAME` too): the format, then, is the next.
      const { options, dynamic } = getopt(values, name === 'printf' ? 'v:' : 'fnp:');
      if (dynamic) set(null);
      for (const [letter, value] of options) if (letter === 'v' || letter === 'p') set(value ?? null);
      return;
    }
    if (name === 'getopts') return set(named(1));
    const { options, rest, dynamic, bad } = getopt(values, name === 'read' ? 'Eersa:d:i:n:N:p:t:u:' : 'd:u:n:O:tC:c:s:');
    if (bad) return;
    if (dynamic && name !== 'read')
      this.finding(ctx, 'dynamic-script', `${name} has an option only known at run time, which may be a callback`, call.span);
    for (const [letter, value] of options) {
      if (letter === 'C') this.callback(value, state, ctx, call, name);
      if (letter === 'a') set(value ?? null);
    }
    const positionals = values.slice(rest).map((_, i) => named(rest + i));
    if (name === 'read') (positionals.length > 0 ? positionals : ['REPLY']).forEach(set);
    else set(positionals[0] === undefined ? 'MAPFILE' : positionals[0]);
  }

  /**
   * The code `-C` gives `mapfile`, `compgen` or `complete`, run with arguments appended: by `mapfile` as `eval` runs
   * code, by the others as a substitution.
   */
  callback(code: string | undefined, state: State, ctx: Context, call: Call, name: string): void {
    if (code === undefined) {
      this.finding(ctx, 'dynamic-script', `${name} -C runs a string only known at run time`, call.span);
    }
    // mapfile runs its callback in the shell itself, any number of times; compgen in a subshell.
    else if (name === 'mapfile') {
      const before = clone(state);
      settle(state, [clone(state), this.branch(state, ctx, (s, c) => this.code(code, s, c, call, `${name} -C`, true, false))]);
      // Run again, what it changes changes again: `cd ..` may be any number of levels up.
      if (state.cwd !== before.cwd) state.cwd = undefined;
      for (const [variable, value] of state.vars) {
        const was = before.vars.get(variable);
        if (!was || !sameValue(was, value)) state.vars.set(variable, { kind: 'dynamic' });
      }
    } else {
      this.code(code, clone(state), ctx, call, `${name} -C`, true, true);
    }
  }

  /**
   * `set`, as far as it changes the options `shellOption` knows. Bash reads the options twice. First as getopt does,
   * with `-o` taking the rest of its word, or the next word unless that looks like an option: a bad letter there makes
   * `set` change nothing. Then one at a time, `-o` taking the next word as an option's name (unless it looks like an
   * option: then it lists them): a bad letter or name stops there, and what came before stays.
   */
  set(values: (string | undefined)[], state: State, ctx: Context, call: Call): void {
    const unknown = () => this.anyOption(state, ctx, call);
    const option = (value: string | undefined) => value === undefined || (/^[-+]./.test(value) && value !== '--');
    for (let i = 0; i < values.length && option(values[i]); i++) {
      const value = values[i];
      if (value === undefined) return unknown();
      const at = value.indexOf('o');
      if (/[^abefhkmnptuvxBCEHPTo]/.test(value.slice(1, at === -1 ? undefined : at))) return;
      if (at !== value.length - 1) continue;
      if (i + 1 < values.length && values[i + 1] === undefined) return unknown();
      if (i + 1 < values.length && !/^[-+]/.test(values[i + 1]!)) i++;
    }
    // Builds differ (Git Bash has `igncr`): an option name this doesn't know may make `set` stop.
    let sure = true;
    for (let i = 0; i < values.length && option(values[i]); i++) {
      const value = values[i]!;
      const on = value.startsWith('-');
      for (const letter of value.slice(1)) {
        if (letter !== 'o') {
          if (!'abefhkmnptuvxBCEHPT'.includes(letter)) return;
          if (setLetters[letter]) this.shellOption('set', setLetters[letter], on, sure, state, ctx, call);
          continue;
        }
        const name = values[i + 1];
        if (i + 1 === values.length || /^[-+]|^$/.test(name ?? 'x')) continue;
        if (name === undefined) return unknown();
        i++;
        if (setOptions.has(name)) this.shellOption('set', name, on, sure, state, ctx, call);
        else sure = false;
      }
    }
  }

  /** History expansion turned on: a `!` in a later line may become any earlier command line (`!!`), which isn't followed. */
  historyExpansion(ctx: Context, call: Call): void {
    this.finding(ctx, 'dynamic-script', 'History expansion may run earlier command lines again', call.span);
  }

  /**
   * A shell option turned on or off by `set`, `shopt` or a shell's own options (`kind` says whose name it is), or only
   * maybe (`sure` false). Those that change how Bash reads or expands code, which the analysis doesn't follow, are
   * findings: a compatibility level, `keyword` (assignments anywhere in a command), and `braceexpand` off.
   */
  shellOption(kind: 'set' | 'shopt', name: string, on: boolean, sure: boolean, state: State, ctx: Context, call: Call): void {
    const unfollowed =
      (kind === 'shopt' && /^compat\d+$/.test(name)) || (kind === 'set' && name === 'keyword')
        ? on
        : kind === 'set' && name === 'braceexpand' && !on;
    if (unfollowed) {
      const message = `\`${name}\` ${on ? 'on' : 'off'} changes how Bash reads or expands code, which the analysis doesn't follow`;
      return this.finding(ctx, 'unknown-syntax', message, call.span);
    }
    if (kind === 'set' && name === 'histexpand' && on) return this.historyExpansion(ctx, call);
    if (kind === 'set' && name === 'posix') return sure ? setPosix(state, on) : maybePosix(state, on);
    if (kind === 'shopt' && name === 'expand_aliases') {
      state.expandAliases = sure || state.expandAliases === on ? on : undefined;
      return;
    }
    if (followed[kind].has(name)) state.options.set(name, sure || option(state, name) === on ? on : undefined);
  }

  /** Options `set` (or `shopt`) was given that are only known at run time: any may have changed. */
  anyOption(state: State, ctx: Context, call: Call): void {
    state.expandAliases = undefined;
    state.posix = undefined;
    for (const name of [...followed.set, ...followed.shopt]) state.options.set(name, undefined);
    this.historyExpansion(ctx, call);
    this.finding(ctx, 'unknown-syntax', 'Shell options only known at run time may change how Bash reads or expands code', call.span);
  }

  /**
   * `hash [-lrt] [-p path] [-d] [name…]`: options up to the first name, as getopt reads them. `-r` empties the table
   * first; then `-p` gives each name the path, and otherwise a name is looked up on `PATH` again (`-d`: forgotten),
   * either way leaving the table. A name with a `/` is skipped, `-t` only prints, and a bad option changes nothing.
   * Words only known at run time leave unknown which names change: with a path, any command may run it.
   */
  hash(values: (string | undefined)[], state: State, ctx: Context, call: Call): void {
    const flags = new Set<string>();
    let path: string | undefined;
    let i = 0;
    for (; i < values.length; i++) {
      const value = values[i];
      if (value === undefined) return this.finding(ctx, 'dynamic-command', '`hash` has options only known at run time', call.span);
      if (value === '--') {
        i++;
        break;
      }
      if (!value.startsWith('-') || value === '-') break;
      for (let j = 1; j < value.length; j++) {
        const flag = value[j]!;
        if (!'lrtpd'.includes(flag)) return;
        flags.add(flag);
        if (flag !== 'p') continue;
        if (j + 1 < value.length) path = value.slice(j + 1);
        else if (i + 1 < values.length) path = values[++i];
        else return;
        break;
      }
    }
    const names = values.slice(i);
    if (flags.has('t')) return;
    if (flags.has('r')) {
      state.hashed.clear();
      state.hashUnknown = false;
    }
    for (const name of names) {
      if (name === undefined) {
        if (flags.has('p'))
          return this.finding(ctx, 'dynamic-command', '`hash -p` gives a path to a command named only at run time', call.span);
        for (const known of state.hashed.keys()) state.hashed.set(known, undefined);
        continue;
      }
      if (name.includes('/')) continue;
      if (flags.has('p')) state.hashed.set(name, path);
      else state.hashed.delete(name);
    }
  }

  /** A program run from `PATH`, a path, or what `hash -p` gave the name. */
  program(argv: Arg[], state: State, ctx: Context, call: Call): void {
    const name = (argv[0] as Extract<Arg, { kind: 'static' }>).value;
    // With it in their environment, GNU programs read options only up to the first operand (`cp a b -S x` copies `-S`).
    if (state.exported.has('POSIXLY_CORRECT') && state.vars.has('POSIXLY_CORRECT'))
      this.finding(ctx, 'sensitive-variable', `POSIXLY_CORRECT changes how \`${name}\` reads its options`, call.span);
    if (!name.includes('/') && state.hashUnknown && !state.hashed.has(name)) {
      this.finding(ctx, 'loads-code', `\`${name}\` may have been given a path through BASH_CMDS`, call.span);
      return this.run(argv, state, ctx, call, undefined);
    }
    if (name.includes('/') || !state.hashed.has(name)) return this.run(argv, state, ctx, call, name.includes('/') ? name : undefined);
    const path = state.hashed.get(name);
    if (path === undefined) {
      this.finding(ctx, 'loads-code', `\`${name}\` was given a path only known at run time`, call.span);
      return this.run(argv, state, ctx, call, undefined);
    }
    // The path runs only when it's there: otherwise Bash looks the name up on `PATH`.
    settle(state, [
      this.branch(state, ctx, (s, c) => this.run(argv, s, c, call, path)),
      this.branch(state, ctx, (s, c) => this.run(argv, s, c, call, undefined)),
    ]);
  }

  /** `argv` run as a program, from `path` or else found on `PATH`. */
  run(argv: Arg[], state: State, ctx: Context, call: Call, path: string | undefined): void {
    const name = (argv[0] as Extract<Arg, { kind: 'static' }>).value;
    const program = path ? basename(path) : name;
    const parsed = normalize(this.withAppended(argv.slice(1), ctx, call), specFor(program));
    if (path && !isSystemPath(path)) parsed.effects.add('exec:file');
    // An interactive shell reads ~/.bashrc, a login shell /etc/profile and ~/.profile: code the analysis doesn't see.
    const { options } = parsed;
    if (specFor(program) === specFor('bash') && ((options['-i'] && !options['--norc']) || (options['--login'] && !options['--noprofile'])))
      this.finding(ctx, 'exec-config', `${program} runs its startup files, which the analysis doesn't see`, call.span);
    for (const entry of parsed.env) {
      // env sets a name no shell variable has (`--x=1`) too: no program reads it as one.
      const start = entry.kind === 'static' ? entry.value : entry.prefix;
      // `BASH_FUNC_name%%`, no variable's name, is a function a Bash it starts defines.
      if (start.startsWith('BASH_FUNC_'))
        this.finding(ctx, 'sensitive-variable', `${program} gives a shell it starts a function through the environment`, call.span);
      if (!assignment.test(start)) continue;
      const equals = start.indexOf('=');
      const value: Value = entry.kind === 'static' ? { kind: 'static', value: entry.value.slice(equals + 1) } : { kind: 'dynamic' };
      this.assigned(start.slice(0, equals), value, state, ctx, call, false, false);
    }
    // A program changes directory as the kernel does: `link/..` is up from where the symlink leads.
    const cwd = parsed.cwd?.kind === 'static' ? this.openedPath(call.cwd, parsed.cwd.value, call.home) : parsed.cwd ? undefined : call.cwd;
    // Project code is the code of the project where the script starts: elsewhere (`npm --prefix /tmp/x test`,
    // `cd .. && cargo build`), it's another project's, from a place no one vouched for.
    // Where it really is, too: a symlink under the project (`cd link`) may lead out of it.
    const realStart = this.files && this.start.startsWith('/') ? this.files.physical(this.start) : undefined;
    const outside = (path: string | undefined) => {
      if (path === undefined || compare(path, this.start) !== true) return true;
      if (!this.files || !this.start.startsWith('/')) return false;
      const real = this.changed(path, ctx, 'links') === true ? undefined : this.files.physical(path);
      return real === undefined || realStart === undefined || compare(real, realStart) !== true;
    };
    if (parsed.effects.has('exec:project') && outside(cwd)) parsed.effects.add('exec:file');
    // What git checked out may hold anything: without files to follow, its project code is no one's.
    if (parsed.effects.has('exec:project') && program !== 'git' && !this.files && this.rewritten) parsed.effects.add('exec:file');
    if (program === 'git' && gitWritesTree.test(parsed.subcommands.join(' '))) this.rewritten = true;
    // A workspace or package another than the one here (`npm -w ../b test`, `cargo test -p b`) is another's code,
    // unless it's a path inside the project.
    const selectors = workspaces[program] ?? (program === 'cargo' ? ['--package', '--workspace', '--exclude'] : []);
    for (const value of selectors.flatMap((name) => parsed.options[name] ?? [])) {
      const path = value !== true && value.kind === 'static' && /^\.?\.?\//.test(value.value) ? value.value : undefined;
      if (path === undefined || outside(resolvePath(cwd, path, call.home))) parsed.effects.add('exec:file');
    }
    // Another repository's config and hooks are its own, whatever the command: `core.fsmonitor` runs on `git status`.
    if (program === 'git') {
      const places = ['--git-dir', '--work-tree'].flatMap((name) => parsed.options[name] ?? []);
      const elsewhere = places.some(
        (place) => place === true || outside(place.kind === 'static' ? resolvePath(cwd, place.value, call.home) : undefined),
      );
      if (outside(cwd) || elsewhere) parsed.effects.add('exec:file');
    }
    for (const arg of parsed.loads ?? []) {
      if (!outside(arg.kind === 'static' ? resolvePath(cwd, arg.value, call.home) : undefined)) continue;
      parsed.effects.add('exec:file');
      parsed.reads.push(arg);
    }
    // Which package.json scripts it runs, known before it's recorded: a name no script has is a file or a command.
    const scripts = packageManagers.has(program) ? this.packageScripts(program, cwd, parsed, ctx, call) : undefined;
    this.emit(ctx, call, program, 'external', argv, parsed, path);
    // Whether the project code it runs (hooks, package scripts) was walked, along with what that code writes.
    let followed = false;
    if (program === 'git') {
      for (const config of parsed.configs) this.gitConfigEntry(config, state, ctx, call);
      followed = this.gitProject(cwd, parsed, state, ctx, call);
    } else if (scripts) {
      // Run with `sh -c`, which expands aliases.
      for (const [name, script] of scripts.run) {
        this.dashSyntax(script, ctx, call, `${program} ${name}`);
        this.code(script, shellState(state, cwd, 'sh'), ctx, call, `${program} ${name}`);
      }
      followed = scripts.followed;
    } else if (program === 'ssh') {
      for (const value of parsed.options['-o'] ?? []) {
        if (value === true || value.kind === 'dynamic') {
          this.finding(ctx, 'dynamic-script', 'ssh -o contains a local command only known at run time', call.span);
        } else {
          const match = /^(?:ProxyCommand|LocalCommand|KnownHostsCommand)(?:\s+|=\s*)(.+)$/i.exec(value.value);
          if (match) this.code(match[1]!, childState(state, cwd), ctx, call, `ssh ${value.value.split(/\s/, 1)[0]}`);
        }
      }
      for (const file of parsed.options['-F'] ?? []) {
        if (file === true || file.kind === 'dynamic')
          this.finding(ctx, 'exec-config', 'ssh config file is only known at run time', call.span);
        else this.sshConfig(resolvePath(cwd, file.value) ?? file.value, cwd, state, ctx, call, new Set(), 0);
      }
    }
    const inner: Context = { ...ctx, via: [...ctx.via, program], externalOnly: true };
    const innerCall = (open: boolean): Call => ({
      ...call,
      writes: [],
      reads: [],
      command: undefined,
      noFunctions: true,
      open: open || call.open,
      cwd,
    });
    // What a program starts is found on `PATH`: the shell's `hash -p` table isn't passed on.
    const unhashed = () => passed({ ...clone(state), hashed: new Map<string, string | undefined>(), hashUnknown: false });
    // What a wrapper puts in its command's environment (`env -i`, `-u x`, `x=`): what a shell under it sees.
    const passed = (s: State): State => {
      if (parsed.options['--ignore-environment']) {
        for (const name of s.exported) s.vars.delete(name);
        s.exported.clear();
        s.maybeExported.clear();
      }
      for (const name of parsed.options['--unset'] ?? []) {
        if (name !== true && name.kind === 'static') {
          s.vars.delete(name.value);
          s.exported.delete(name.value);
        } else {
          for (const exported of s.exported) s.maybeExported.add(exported);
        }
      }
      for (const entry of parsed.env) {
        const text = entry.kind === 'static' ? entry.value : entry.prefix;
        const equals = text.indexOf('=');
        if (equals <= 0 || !assignment.test(text)) {
          for (const exported of s.exported) s.maybeExported.add(exported);
          continue;
        }
        const name = text.slice(0, equals);
        s.vars.set(name, entry.kind === 'static' ? { kind: 'static', value: text.slice(equals + 1) } : { kind: 'dynamic' });
        s.exported.add(name);
        s.maybeExported.delete(name);
      }
      return s;
    };
    for (const nested of parsed.nested) this.dispatch(nested.argv, unhashed(), inner, innerCall(nested.open));
    for (const text of parsed.argvStrings) {
      const words = text.kind === 'static' ? resolveWords(text.value, lookupIn(state)) : undefined;
      if (words) this.dispatch(words, unhashed(), inner, innerCall(false));
      else this.finding(ctx, 'dynamic-script', `${program} runs a command line only known at run time`, call.span);
    }
    const stdin = parsed.stdinScript ? this.stdinScript(call, state) : undefined;
    if (parsed.stdinScript && !stdin) this.finding(ctx, 'dynamic-script', `${program} runs code from its standard input`, call.span);
    for (const script of stdin ? [...parsed.scripts, stdin] : parsed.scripts) {
      if (script.kind === 'dynamic') {
        this.finding(ctx, 'dynamic-script', `${program} runs code only known at run time: ${script.text}`, call.span);
        continue;
      }
      const remote = parsed.effects.has('exec:remote');
      // Bash runs its own; anything else (`sh -c`, `watch`, `git rebase -x`) hands it to `sh`, which may be dash.
      const sh = !remote && program !== 'bash';
      const shell = remote ? freshState(undefined) : sh ? shellState(state, cwd, 'sh') : childState(state, cwd, true);
      if (!remote && specFor(program) === specFor('bash')) this.childOptions(program, parsed, state, shell, ctx, call);
      if (sh) this.dashSyntax(script.value, ctx, call, program);
      this.code(
        script.value,
        shell,
        { ...ctx, via: [...ctx.via, program], externalOnly: false, calls: [], loops: [], returns: undefined },
        call,
        remote ? `${program} (remote)` : script === stdin ? `${program} <<` : `${program} -c`,
      );
    }
    // After what it reads first: `git config k v` reads the config, then writes it.
    const edits = specFor(program)?.edits;
    // A program that names what it writes only by the kind of file writes those files where they are, and no others.
    if (edits && (parsed.effects.has('fs:write') || parsed.effects.has('fs:delete'))) this.wrotePattern(edits);

    const unknown = writesUnknown(program, parsed, followed);
    // Project code may write anything: what its spec names (`oxlint --fix src`) is its own writing too. Where a program
    // with `edits` only rewrites files of its kind, the pattern stands for what it writes; elsewhere (`tsc --outFile`)
    // it writes the file it's given, whatever its name.
    const named = edits ? parsed.writes.filter((write) => !parsed.edited?.includes(write)) : parsed.writes;
    if (unknown !== 'project') this.wrote(named, call, edits ? 'contents' : writeKind(program));
    if (unknown !== false) this.wroteAnything(unknown === 'project');
  }

  /**
   * The options of a shell this one starts: its own (`-o`, `+O`, set's letters), and this shell's when it exports
   * BASHOPTS or SHELLOPTS, which a starting Bash reads from its environment.
   */
  childOptions(program: string, parsed: Parsed, state: State, shell: State, ctx: Context, call: Call): void {
    shell.expandAliases = childAliases(program, parsed, shell);
    shell.posix = childPosix(program, parsed, shell);
    // An interactive shell expands history too.
    if (parsed.options['-i']) this.historyExpansion(ctx, call);
    const passed = (variable: string, on: boolean | undefined) =>
      !state.exported.has(variable) ? false : state.maybeExported.has(variable) && on !== false ? undefined : on;
    shell.expandAliases = either(shell.expandAliases, passed('BASHOPTS', state.expandAliases));
    shell.posix = either(shell.posix, passed('SHELLOPTS', state.posix));
    // POSIX mode turns expand_aliases on.
    shell.expandAliases = either(shell.expandAliases, shell.posix);
    for (const name of followed.shopt) shell.options.set(name, passed('BASHOPTS', option(state, name)));
    for (const name of followed.set) shell.options.set(name, passed('SHELLOPTS', option(state, name)));
    const named = [
      ['-o', 'set', true],
      ['+o', 'set', false],
      ['-O', 'shopt', true],
      ['+O', 'shopt', false],
    ] as const;
    for (const [flag, kind, on] of named) {
      for (const value of parsed.options[flag] ?? []) {
        if (value === true) continue;
        if (value.kind === 'dynamic') this.anyOption(shell, ctx, call);
        else this.shellOption(kind, value.value, on, true, shell, ctx, call);
      }
    }
    for (const [letter, name] of Object.entries(setLetters)) {
      if (parsed.options[`-${letter}`]) this.shellOption('set', name, true, true, shell, ctx, call);
      if (parsed.options[`+${letter}`]) this.shellOption('set', name, false, true, shell, ctx, call);
    }
  }

  /**
   * The code a shell reads from its standard input, when the command's last redirection of it is a here-document or a
   * here-string. Other input (a file, a pipe, the caller's) isn't followed, which is a finding.
   */
  stdinScript(call: Call, state: State): Arg | undefined {
    const input = call.command?.redirects.findLast((redirection) => {
      const fd = redirection.descriptor?.type === 'FileDescriptor' ? redirection.descriptor.value : undefined;
      return fd === undefined ? redirection.type !== 'Redirect' || /^<(&|>)?$/.test(redirection.operator) : fd === 0;
    });
    if (input?.type === 'HereString' && input.target) {
      const [word, ...more] = resolveWord(input.target, lookupIn(state));
      if (word?.kind === 'static' && more.length === 0) return { kind: 'static', value: `${word.value}\n` };
      return dynamicArg(input.target.text, 'substitution', false, '');
    }
    if (input?.type !== 'HereDoc') return undefined;
    const { body, delimiter, operator } = input;
    // Unquoted, a backslash quotes only `$`, `` ` ``, `\` and a newline.
    const text = delimiter?.quoted
      ? body.text
      : !body.parts
        ? body.text.replaceAll(/\\([$`\\\n])/g, (_, char: string) => (char === '\n' ? '' : char))
        : body.parts.every((part) => part.type === 'Literal')
          ? body.parts.map((part) => part.value).join('')
          : undefined;
    if (text === undefined) return dynamicArg(body.text, 'substitution', false, '');
    return { kind: 'static', value: operator === '<<-' ? text.replaceAll(/^\t+/gm, '') : text };
  }

  /** `git -c key=value`: entries that make git run commands, which are followed when they're shell code. */
  gitConfigEntry(entry: Arg, state: State, ctx: Context, call: Call): void {
    if (entry.kind === 'dynamic') return this.finding(ctx, 'exec-config', `git config only known at run time: ${entry.text}`, call.span);
    const equals = entry.value.indexOf('=');
    const key = equals < 0 ? entry.value : entry.value.slice(0, equals);
    const value = equals < 0 ? 'true' : entry.value.slice(equals + 1);
    const risk = gitConfig(key, value);
    if (!risk) return;
    this.finding(ctx, 'exec-config', `git config \`${key}\` changes what git runs`, call.span);
    if (risk.script !== undefined) {
      this.code(
        risk.script,
        childState(state, state.cwd),
        { ...ctx, via: [...ctx.via, 'git'], externalOnly: false, calls: [], loops: [], returns: undefined },
        call,
        `git ${key}`,
        true,
      );
    }
  }

  /** Whether something is at `path`: `undefined` when that isn't known, or the script may have changed it (a finding). */
  exists(path: string, ctx: Context, call: Call): boolean | undefined {
    if (path.startsWith('~')) {
      this.finding(ctx, 'unknown-file', `Where \`${path}\` is isn't known`, call.span);
      return undefined;
    }
    const real = this.files!.realpath(path);
    const changed = this.changed(path, ctx, 'contents');
    if (changed !== false) this.changedFinding(path, changed, ctx, call, true);
    if (changed === true) return undefined;
    if (real === undefined) this.finding(ctx, 'unknown-file', `Whether \`${path}\` is there isn't known`, call.span);
    return real === undefined ? undefined : real !== null;
  }

  /**
   * Git config, the work tree's writes and the hooks, of the repository git takes: the one `--git-dir` or `--bare`
   * names, else the first it finds from `cwd` up, in `.git` or in the directory itself. One that may not be a
   * repository (git wants a `HEAD`, `objects` and `refs`) is followed, and so are those above it. `false` when which
   * it takes isn't settled, so what it runs may not all have been followed.
   */
  gitProject(cwd: string | undefined, parsed: Parsed, state: State, ctx: Context, call: Call): boolean {
    if (!this.files || !cwd) return false;
    // What isn't known is read as absent, so that one round of fetching asks for everything up to the root.
    const texts = new Map<string, string | undefined>();
    const readFile = (path: string) => {
      if (!texts.has(path)) texts.set(path, this.read(path, ctx, call));
      return texts.get(path);
    };
    const staticPath = (arg: Arg | true | undefined) =>
      arg !== undefined && arg !== true && arg.kind === 'static' ? this.openedPath(cwd, arg.value, call.home) : undefined;
    const tree = parsed.options['--work-tree']?.at(-1);
    const workTree = staticPath(tree);
    const writesTree = gitWritesTree.test(parsed.subcommands.join(' '));
    const hooks = gitHooksOf(parsed);
    /** Where a worktree's git directory keeps what it shares with the others: its config and hooks. */
    const commonOf = (gitDir: string): string => {
      const pointer = readFile(`${gitDir}/commondir`)?.replace(/[\r\n]+$/, '');
      return pointer ? this.pointedTo(gitDir, pointer, ctx, call) : gitDir;
    };
    /** A directory for certain: something is there, and it isn't a file. */
    const directory = (path: string): boolean => this.exists(path, ctx, call) === true && this.files!.readFile(path) === null;
    /** Whether git takes `gitDir` for certain: a `HEAD` it can read, with the directories `objects` and `refs` beside it. */
    const valid = (gitDir: string): boolean => {
      const head = readFile(`${gitDir}/HEAD`);
      if (head === undefined || !/^(ref:\s*refs\/|[0-9a-f]{40})/.test(head)) return false;
      const common = commonOf(gitDir);
      return directory(`${common}/objects`) && directory(`${common}/refs`);
    };
    /** Whether `gitDir` has a `HEAD`: without one, git never takes it. Not knowing is a finding. */
    const heads = new Map<string, boolean>();
    const hasHead = (gitDir: string): boolean => {
      if (!heads.has(gitDir)) heads.set(gitDir, this.exists(`${gitDir}/HEAD`, ctx, call) === true);
      return heads.get(gitDir)!;
    };

    const followed = new Set<string>();
    const walked = new Set<string>();
    /**
     * Follows the repository in `gitDir` whose work tree is `root`: `inside` is what git doesn't rewrite there, and
     * `hooksFrom` where it runs the hooks, when that's certain.
     */
    const follow = (gitDir: string, root: string, inside: string, hooksFrom?: string): void => {
      if (followed.has(gitDir)) return;
      followed.add(gitDir);
      const common = commonOf(gitDir);
      const entries: { key: string; value: string; conditional: boolean }[] = [];
      const visited = new Set<string>();
      const load = (path: string, depth: number, conditional: boolean): void => {
        if (visited.has(path)) return;
        if (depth > 16) {
          this.finding(ctx, 'exec-config', 'Git config includes exceed the analysis limit', call.span);
          return;
        }
        visited.add(path);
        const text = readFile(path);
        if (text === undefined) return;
        const parsed = parseGitConfig(text);
        if (parsed.bad) this.finding(ctx, 'exec-config', `Git config ${path} isn't read here as git reads it`, call.span);
        for (const entry of parsed.entries) {
          if (entry.key === 'include.path' || (entry.key.startsWith('includeif.') && entry.key.endsWith('.path'))) {
            if (/[${}]/.test(entry.value)) {
              this.finding(ctx, 'exec-config', `Git config include path is dynamic: ${entry.value}`, call.span);
              continue;
            }
            const base = path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '.';
            const included = this.openedPath(base, entry.value, call.home);
            if (included === undefined && entry.value.split('/').includes('..')) {
              this.finding(ctx, 'exec-config', `Where git config include path ${entry.value} leads isn't known`, call.span);
              continue;
            }
            load(included ?? `${base}/${entry.value}`, depth + 1, conditional || entry.key !== 'include.path');
          } else {
            entries.push({ ...entry, conditional });
          }
        }
      };
      load(`${common}/config`, 0, false);
      // What `extensions.worktreeConfig` makes git read as well.
      load(`${gitDir}/config.worktree`, 0, true);
      const hooksPaths = entries.filter((entry) => entry.key.toLowerCase() === 'core.hookspath');
      for (const entry of entries) {
        if (hooksPaths.includes(entry) || !gitConfig(entry.key, entry.value)) continue;
        this.gitConfigEntry({ kind: 'static', value: `${entry.key}=${entry.value}` }, state, ctx, call);
      }
      // The hooks of `core.hooksPath` are followed like those in `.git/hooks`, where that directory is certain: git
      // reads `~` and `%(prefix)` in it, and a relative one from where it runs the hook.
      const hooksPath = hooksPaths.at(-1)?.value;
      // A repository whose config says it's bare runs a relative hooks path from wherever git started.
      const bare = entries.some((entry) => entry.key === 'core.bare' && !/^(false|no|off|0)$/i.test(entry.value));
      const certain = (path: string): string | undefined => {
        if (path === '' || path.startsWith('%(') || hooksPaths.some((entry) => entry.conditional)) return undefined;
        if (path.startsWith('/')) return this.openedPath(root, path);
        if (path.startsWith('~'))
          return /^~(\/|$)/.test(path) && call.home !== undefined ? this.openedPath(root, path, call.home) : undefined;
        return hooksFrom === undefined || bare ? undefined : this.openedPath(hooksFrom, path);
      };
      let directory = `${common}/hooks`;
      if (hooksPath !== undefined) {
        const known = certain(hooksPath);
        if (known === undefined) this.gitConfigEntry({ kind: 'static', value: `core.hooksPath=${hooksPath}` }, state, ctx, call);
        directory = known ?? resolvePath(root, hooksPath) ?? hooksPath;
      }

      if (writesTree && tree !== undefined && workTree === undefined) this.wroteAnything();
      else if (writesTree) this.wroteTree(workTree ?? root, inside);
      for (const name of hooks) {
        if (flag(parsed, '--no-verify') && !parsed.options['--verify'] && ['pre-commit', 'commit-msg', 'pre-push'].includes(name)) continue;
        const path = `${directory}/${name}`;
        if (walked.has(path)) continue;
        walked.add(path);
        const script = readFile(path);
        // husky's stub runs the project's hook in `.husky`, which is what's walked.
        const hook = script === undefined ? undefined : huskyHook(path, script, readFile);
        if (!hook) continue;
        // Git runs it with what its first line names, and with `sh` when there's none; husky's with `sh`.
        const shell = hook.husky ? 'sh' : interpreter(hook.text);
        if (shell === undefined) {
          this.finding(ctx, 'loads-code', `git hook ${name} runs with a program the analysis doesn't read`, call.span);
          continue;
        }
        if (shell === 'sh') this.dashSyntax(hook.text, ctx, call, `git hook ${name}`);
        this.code(hook.text, shellState(state, workTree ?? root, shell), ctx, call, `git hook ${name}`);
      }
      // A hook may write another, or what husky's stubs source, which git runs after it (`reference-transaction` after
      // `pre-commit`, a second stub): each is read again once they've all run, past what was read before.
      for (const path of walked) {
        const again = this.read(path, ctx, call);
        if (again !== undefined) huskyHook(path, again, (file) => this.read(file, ctx, call));
      }
    };

    // `--bare` makes the working directory the repository, unless `--git-dir` names one.
    const given = parsed.options['--git-dir']?.at(-1);
    if (given !== undefined || parsed.options['--bare'] !== undefined) {
      const gitDir = given === undefined ? cwd : staticPath(given);
      if (gitDir === undefined) {
        this.finding(ctx, 'exec-config', 'The repository git reads is only known at run time', call.span);
        return false;
      }
      follow(gitDir, cwd, gitDir);
      return true;
    }

    /** The submodules `.gitmodules` names in the work tree at `root`: commands that look into them run their config. */
    const submodules = (root: string): void => {
      // What was there, since git's own writes to the work tree may rewrite it but make no repository.
      const path = `${root}/.gitmodules`;
      const text = this.files!.readFile(path);
      if (text === undefined) this.finding(ctx, 'unknown-file', `What \`${path}\` holds isn't known`, call.span);
      if (text === undefined || text === null) return;
      const parsed = parseGitConfig(text);
      if (parsed.bad) this.finding(ctx, 'exec-config', `${root}/.gitmodules isn't read here as git reads it`, call.span);
      for (const entry of parsed.entries) {
        if (!/^submodule\..*\.path$/.test(entry.key)) continue;
        const sub = this.openedPath(root, entry.value);
        if (sub === undefined || !sub.startsWith('/')) {
          this.finding(ctx, 'exec-config', `Where submodule ${entry.value} is isn't known`, call.span);
          continue;
        }
        const dotGit = `${sub}/.git`;
        const pointer = gitfile(readFile(dotGit));
        if (pointer !== undefined) follow(this.pointedTo(sub, pointer, ctx, call), sub, dotGit, sub);
        else if (readFile(`${dotGit}/config`) !== undefined || hasHead(dotGit)) follow(dotGit, sub, dotGit, sub);
      }
    };

    /** Git's discovery from `start` up: whether it settled on a repository, every one it may take followed. */
    const discover = (start: string): boolean => {
      let dir = start;
      for (let depth = 0; depth < 16; depth++) {
        const dotGit = resolvePath(dir, '.git');
        if (!dotGit) return false;
        // A `.git` file names the git directory, which git takes or fails on.
        const pointer = gitfile(readFile(dotGit));
        // Git runs the hooks of a repository it finds in a `.git` in the work tree, unless it's told of another.
        const hooksFrom = tree === undefined ? dir : undefined;
        // What it reads from the work tree, it reads before it writes there.
        if (pointer !== undefined) {
          submodules(dir);
          follow(this.pointedTo(dir, pointer, ctx, call), dir, dotGit, hooksFrom);
          return true;
        }
        if (readFile(`${dotGit}/config`) !== undefined || hasHead(dotGit)) {
          submodules(dir);
          follow(dotGit, dir, dotGit, hooksFrom);
          if (valid(dotGit)) return true;
        }
        // The directory itself, when it has what a `.git` has: a bare repository, or one made to look like it.
        if (hasHead(dir)) {
          follow(dir, dir, dir);
          if (valid(dir)) return true;
        }
        const parent = resolvePath(dir, '..');
        // Up to the root, every directory git may have taken was followed.
        if (!parent || parent === dir) return followed.size > 0;
        dir = parent;
      }
      this.finding(ctx, 'exec-config', 'The repository git finds may be further up than the analysis looks', call.span);
      return false;
    };
    // Git looks up from where it really is (`getcwd`), past the symlinks the shell's path went through.
    const real = cwd.startsWith('/') ? this.files.physical(cwd) : cwd;
    if (real === undefined) this.finding(ctx, 'unknown-file', `Where \`${cwd}\` really is isn't known`, call.span);
    const settled = discover(cwd);
    return real === undefined || real === cwd ? settled : discover(real) && settled;
  }

  /** The git directory a `.git` file or `commondir` names, from `base`, as the kernel finds it. */
  pointedTo(base: string, pointer: string, ctx: Context, call: Call): string {
    const path = this.openedPath(base, pointer);
    if (path !== undefined) return path;
    this.finding(ctx, 'exec-config', `Where the git directory ${pointer} leads isn't known`, call.span);
    return resolvePath(base, pointer) ?? pointer;
  }

  /**
   * The package.json scripts npm, pnpm or bun runs, each with its `pre` and `post` scripts, read before the invocation
   * is recorded: once the file shows a name is a script, the command from PATH pnpm and `bun run` would run in its
   * place is dropped, and a name bun finds no script for is a file it runs. `followed` is `false` when what runs may
   * not all be in `run`: no filesystem, a workspace's scripts, or a name only known at run time.
   */
  packageScripts(
    program: string,
    cwd: string | undefined,
    parsed: Parsed,
    ctx: Context,
    call: Call,
  ): { run: [string, string][]; followed: boolean } | undefined {
    const unfollowed = { run: [], followed: false };
    const verb = parsed.subcommands[0];
    // A word npm doesn't know is the start of one of its commands' names, never a script's.
    const given = !verb ? (program === 'npm' ? undefined : parsed.unknownSubcommand) : verb === 'run' ? parsed.positionals[0] : undefined;
    // Without a restart script, `npm restart` runs stop and start: each of them may.
    const names =
      given?.kind === 'static'
        ? [given.value]
        : verb === 'restart'
          ? ['restart', 'stop', 'start']
          : verb === 'test' || verb === 'start' || verb === 'stop' || (program === 'bun' && (verb === 'check' || verb === 'fmt'))
            ? [verb]
            : [];
    const lifecycle = program === 'bun' || !verb ? undefined : lifecycleScripts[verb];
    if (lifecycle) return this.lifecycle(program, lifecycle, cwd, parsed, ctx, call);
    if (names.length === 0 || (program === 'bun' && verb === 'test')) return unfollowed;
    // The words after the name are appended to the script, quoted: they're not the project's, and change what it runs
    // (`npm test -- --config /tmp/x.ts`). Where the script isn't walked with them, they may make it run anything.
    const words = given ? parsed.positionals.slice(1) : parsed.positionals;
    // bun drops a `--` right after the name; npm's own parsing ends at it, and pnpm passes it on.
    const first = words[0];
    const extra = program === 'bun' && first?.kind === 'static' && first.value === '--' ? words.slice(1) : words;
    const unwalked = () => {
      if (extra.length > 0) parsed.effects.add('exec:arbitrary');
      return unfollowed;
    };
    if (!this.files || !cwd || workspaces[program]!.some((option) => parsed.options[option])) return unwalked();
    const shell = parsed.options['--shell']?.[0];
    // bun runs scripts in its own shell unless told the system's.
    if (program === 'bun' && shell !== undefined && (shell === true || shell.kind !== 'static' || shell.value !== 'system'))
      return unwalked();
    const scripts = this.manifestScripts(cwd, ctx, call);
    if (!scripts) return unwalked();
    if (extra.some((arg) => arg.kind !== 'static')) return unwalked();
    const appended = extra.map((arg) => ` '${(arg as Extract<Arg, { kind: 'static' }>).value.replaceAll("'", "'\\''")}'`).join('');
    const [name] = names;
    if (given && scripts[name!] === undefined) {
      if (program !== 'bun') return { run: [], followed: true };
      // bun runs a file of that name, `f` being `f.ts` too, and `bun run` a command from PATH after that.
      parsed.effects.add('exec:file');
      parsed.reads.push(given);
      return unfollowed;
    }
    if (given) parsed.nested = [];
    const run: [string, string][] = [];
    for (const scriptName of names.flatMap((each) => [`pre${each}`, each, `post${each}`])) {
      const script = scripts[scriptName];
      if (typeof script === 'string') run.push([scriptName, names.includes(scriptName) ? script + appended : script]);
      else if (script !== undefined) this.finding(ctx, 'exec-config', `${program} script ${scriptName} is not a string`, call.span);
    }
    return { run, followed: true };
  }

  /**
   * The scripts `npm pack` or `npm version` runs as it goes, and the git that `npm version` commits and tags with
   * before its last, whose hooks run too. `--ignore-scripts` skips the scripts only as a flag: npm reads
   * `--ignore-scripts=false` as the value it says.
   */
  lifecycle(
    program: string,
    names: string[],
    cwd: string | undefined,
    parsed: Parsed,
    ctx: Context,
    call: Call,
  ): { run: [string, string][]; followed: boolean } | undefined {
    const run: [string, string][] = [];
    const version = names.includes('version');
    // npm stages, commits and tags the new version (the hooks of a commit run), unless told not to.
    const git: [string, string] = ['(git)', 'git add -- package.json && git commit -m version && git tag -m version version'];
    if (!this.files || !cwd || workspaces[program]!.some((option) => parsed.options[option]))
      return { run: version ? [git] : [], followed: false };
    if (flag(parsed, '--ignore-scripts')) return { run: version ? [git] : [], followed: true };
    const scripts = this.manifestScripts(cwd, ctx, call);
    for (const name of names) {
      if (name === 'postversion') run.push(git);
      const script = scripts?.[name];
      if (typeof script === 'string') run.push([name, script]);
      else if (script !== undefined) this.finding(ctx, 'exec-config', `${program} script ${name} is not a string`, call.span);
    }
    return { run, followed: scripts !== undefined };
  }

  /** The scripts in the package.json in `cwd`, or `undefined` when they can't be read (a finding says why). */
  manifestScripts(cwd: string, ctx: Context, call: Call): Record<string, unknown> | undefined {
    const path = `${cwd}/package.json`;
    // Without one here, the package manager looks in the directories above.
    const absent = this.files!.readFile(path) === null && this.changed(path, ctx, 'contents') === false;
    const manifest = this.read(path, ctx, call);
    if (manifest === undefined) {
      if (!absent) return undefined;
      this.finding(ctx, 'exec-config', `No package.json in ${cwd}; the scripts of one above it cannot be inspected`, call.span);
      return undefined;
    }
    let packageJson: unknown;
    try {
      packageJson = JSON.parse(manifest);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.finding(ctx, 'exec-config', 'package.json is invalid JSON; its scripts cannot be inspected', call.span);
      return undefined;
    }
    // bun takes the first of a key given twice, and npm (as JSON.parse) the last.
    if (repeatsKey(manifest)) {
      this.finding(ctx, 'exec-config', 'package.json gives a key twice, which package managers read differently', call.span);
      return undefined;
    }
    if (typeof packageJson !== 'object' || packageJson === null || Array.isArray(packageJson)) {
      this.finding(ctx, 'exec-config', 'package.json is not an object; its scripts cannot be inspected', call.span);
      return undefined;
    }
    if (!('scripts' in packageJson) || packageJson.scripts === undefined) return {};
    const { scripts } = packageJson;
    if (typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts)) return scripts as Record<string, unknown>;
    this.finding(ctx, 'exec-config', 'package.json scripts are not a readable object', call.span);
    return undefined;
  }

  sshConfig(path: string, cwd: string | undefined, state: State, ctx: Context, call: Call, visited: Set<string>, depth: number): void {
    if (!this.files || visited.has(path)) return;
    if (depth > 16) return this.finding(ctx, 'exec-config', 'SSH config includes exceed the analysis limit', call.span);
    visited.add(path);
    const text = this.read(path, ctx, call);
    if (text === undefined) return;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const [directive, ...rest] = line.split(/\s+/);
      const value = rest.join(' ').replace(/^(['"])(.*)\1$/, '$2');
      if (/^(?:ProxyCommand|LocalCommand|KnownHostsCommand)$/i.test(directive!)) {
        this.code(value, childState(state, cwd), ctx, call, `ssh ${directive}`);
      } else if (/^Match$/i.test(directive!) && /^exec\s+/i.test(value)) {
        this.code(value.replace(/^exec\s+/i, '').replace(/^(['"])(.*)\1$/, '$2'), childState(state, cwd), ctx, call, 'ssh Match exec');
      } else if (/^Include$/i.test(directive!)) {
        if (/[*?[]/.test(value)) {
          this.finding(ctx, 'exec-config', `SSH config include has a glob: ${value}`, call.span);
        } else {
          this.sshConfig(
            resolvePath(path.slice(0, Math.max(0, path.lastIndexOf('/'))), value) ?? value,
            cwd,
            state,
            ctx,
            call,
            visited,
            depth + 1,
          );
        }
      }
    }
  }

  /** Code that runs later (a trap action, a prompt string) is set in `slots`, in place of what they held. */
  later(state: State, slots: string[], label: string, text: string, call: Call, walk: Later['walk']): void {
    const later: Later = { key: `${label}\0${call.span.join()}\0${text}`, walk };
    for (const slot of slots) state.later.set(slot, [later]);
  }

  /**
   * A point between two commands, where code set to run later may run (a signal, a failing command, `set -x`): any
   * number of times, each in the state it finds, leaving its changes behind. It's walked in every state it may find
   * until what it leaves settles. A state it was already walked in isn't walked again.
   */
  between(state: State, ctx: Context): void {
    if (state.later.size === 0) return;
    for (let i = 0; ; i++) {
      const before = clone(state);
      for (const later of new Map([...state.later.values()].flat().map((later) => [later.key, later])).values()) {
        if (this.running.has(later.key)) continue;
        const key = `${later.key}\0${[...this.running].join('\0')}\0${this.writes}\0${this.stateKey(state)}`;
        const ran = this.ran.get(`${key}\0loud`) ?? (ctx.silent ? this.ran.get(`${key}\0silent`) : undefined);
        if (ran) {
          join(state, ran);
          continue;
        }
        const after = clone(state);
        this.running.add(later.key);
        later.walk(after, ctx.silent);
        this.running.delete(later.key);
        this.ran.set(`${key}\0${ctx.silent ? 'silent' : 'loud'}`, after);
        join(state, after);
      }
      if (equal(before, state)) return;
      if (i === maxIterations)
        return this.alarm('Code that runs later changes more than the analysis follows', ctx.outer ?? [0, ctx.source.length]);
    }
  }

  parse(text: string): ParsedScript {
    const known = this.scripts.get(text);
    if (known) return known;
    const script = parse(text);
    this.scripts.set(text, script);
    return script;
  }

  /**
   * Code in a string (`bash -c`, `eval`, `trap`, an alias): parsed and walked in `state`. `late` when Bash runs it as a
   * substitution (`compgen -C`): see `Context`.
   */
  code(text: string, state: State, ctx: Context, call: Call, label: string, open = false, late = false): void {
    if (ctx.depth >= this.maxDepth)
      return this.finding(ctx, 'too-deep', `Code nests deeper than the analysis follows (${label})`, call.span);
    if (opensOutputs.test(text)) this.outputsRead = true;
    this.script(this.parse(text), state, {
      ...ctx,
      source: text,
      outer: call.span,
      nesting: [...ctx.nesting, label],
      depth: ctx.depth + 1,
      writes: [],
      reads: [],
      open: ctx.open || open,
      late,
      quoted: false,
    });
  }

  /**
   * Code `sh` runs is walked as Bash in POSIX mode reads it. Where `sh` is dash, Bash's own syntax means something else
   * (`&>` runs in the background, `((` opens two subshells, `$'…'` is no string): a finding, as what runs isn't known.
   */
  dashSyntax(text: string, ctx: Context, call: Call, label: string): void {
    if (bashOnly.test(text)) this.finding(ctx, 'unknown-syntax', `${label} runs code \`sh\` may read otherwise than Bash`, call.span);
  }

  /**
   * `variable` set to `value`, in the shell itself (`shell`) or in the environment of what it runs. Some variables
   * change what runs, a finding. Prompt strings and `PROMPT_COMMAND` hold code, which is walked when it's known: in
   * the shell, as code that runs later (see `between`); for what it runs, now. An integer variable's value is
   * evaluated first when Bash itself assigns it (`bash`); the result is what it holds.
   */
  assigned(variable: string, value: Value, state: State, ctx: Context, call: Call, shell: boolean, bash = true): Value {
    // Through a nameref, the assignment lands on whichever variable it names.
    if (bash && state.refs.has(variable)) {
      this.anyVariable(state, ctx, call, `${variable} may be a nameref: assigning it sets another variable`);
      return { kind: 'dynamic' };
    }
    // Bash enters POSIX mode again, turning expand_aliases on, even when it was in it.
    if (shell && variable === 'POSIXLY_CORRECT') {
      state.posix = true;
      state.expandAliases = true;
    }
    // Their elements are the alias table and the `hash` table.
    if (bash && variable === 'BASH_ALIASES') state.aliasesUnknown = true;
    if (bash && variable === 'BASH_CMDS') {
      for (const name of state.hashed.keys()) state.hashed.set(name, undefined);
      state.hashUnknown = true;
    }
    if (variable === 'BASH_COMPAT') {
      this.finding(
        ctx,
        'unknown-syntax',
        "BASH_COMPAT changes how Bash reads or expands code, which the analysis doesn't follow",
        call.span,
      );
    }
    if (shell && bash) exportAll(state, variable, state.exported, state.maybeExported);
    const prompt = /^PS[0124]$/.test(variable);
    if ((prompt || variable === 'PROMPT_COMMAND') && value.kind === 'static') {
      const text = value.value;
      const walk: Later['walk'] = (s, silent) =>
        prompt ? this.prompt(text, s, { ...ctx, silent }, call, variable) : this.code(text, s, { ...ctx, silent }, call, variable);
      if (shell) this.later(state, [variable], variable, text, call, walk);
      else walk(clone(state), ctx.silent);
    } else if (prompt || variable === 'PROMPT_COMMAND') {
      this.finding(ctx, 'dynamic-script', `${variable} is set to code only known at run time`, call.span);
    } else if (sensitive.test(variable)) {
      this.finding(ctx, 'sensitive-variable', `Setting ${variable} changes what runs or how`, call.span);
    }
    if (bash && state.cases.has(variable)) value = cased(value, state.cases.get(variable));
    if (!bash || !state.integers.has(variable)) return value;
    // An integer variable evaluates what it's assigned as arithmetic, so that's what it holds.
    // One that may not have the attribute may hold the text itself, which arithmetic later evaluates as it is then.
    const sure = !state.maybeIntegers.has(variable);
    if (value.kind === 'static') {
      const numeric = this.arithmeticText(value.value, state, ctx, value.value, call.span);
      return { kind: 'dynamic', ...(numeric && sure ? { numeric: true } : {}) };
    }
    if (value.numeric) return value;
    this.finding(
      ctx,
      'dynamic-arithmetic',
      `${variable} is an integer variable, and is assigned a value only known at run time`,
      call.span,
    );
    return { kind: 'dynamic' };
  }

  /**
   * A variable named only at run time is assigned or unset (`printf -v "$name"`, a nameref): it may be any of them, so
   * every value is unknown, and so are the alias and `hash` tables, POSIX mode, and the code `PS4` holds. The name may
   * have a subscript, which Bash expands: code only known at run time.
   */
  anyVariable(state: State, ctx: Context, call: Call, message: string): void {
    this.finding(ctx, 'sensitive-variable', message, call.span);
    this.finding(ctx, 'dynamic-script', 'A variable named only at run time may have a subscript with code in it', call.span);
    for (const name of state.vars.keys()) state.vars.set(name, { kind: 'dynamic' });
    state.aliasesUnknown = true;
    for (const name of state.hashed.keys()) state.hashed.set(name, undefined);
    state.hashUnknown = true;
    maybePosix(state, true);
    const prompt: Later = {
      key: `PS4\0${call.span.join()}\0unknown`,
      walk: (_, silent) => this.finding({ ...ctx, silent }, 'dynamic-script', 'PS4 may hold code only known at run time', call.span),
    };
    const set = state.later.get('PS4') ?? [];
    if (!set.some((later) => later.key === prompt.key)) state.later.set('PS4', [...set, prompt]);
  }

  /**
   * Text expanded like a here-document's body (a prompt string): the substitutions in it run. `doubleQuoted`: as a
   * double-quoted string's, which is the same but for `"`, and how the parser reads `'` in `${…}`.
   */
  expansions(text: string, state: State, ctx: Context, call: Call, label: string, doubleQuoted = false): void {
    if (ctx.depth >= this.maxDepth)
      return this.finding(ctx, 'too-deep', `Code nests deeper than the analysis follows (${label})`, call.span);
    let delimiter = 'BASH_GATE_EOF';
    while (text.split('\n').includes(delimiter)) delimiter += '_';
    const source = doubleQuoted ? `: "${text}"\n` : `: <<${delimiter}\n${text}\n${delimiter}\n`;
    const script = this.parse(source);
    const inner = {
      ...ctx,
      source,
      outer: call.span,
      nesting: [...ctx.nesting, label],
      depth: ctx.depth + 1,
      writes: [],
      reads: [],
      late: true,
      quoted: false,
    };
    for (const error of script.errors ?? []) this.finding(inner, 'parse-error', `Parse error: ${error.message}`, call.span);
    this.carriageReturn(source, inner);
    this.substitutions(script.commands, state, inner);
  }

  /**
   * Git Bash (Bash on Windows) drops a carriage return from code it parses, where the parser reads it as Bash on Linux
   * does: part of a word.
   */
  carriageReturn(code: string, ctx: Context): void {
    const at = code.indexOf('\r');
    if (at !== -1) this.finding(ctx, 'parse-error', 'A carriage return in code: Git Bash drops it, Bash on Linux keeps it', [at, at + 1]);
  }

  /**
   * `args` with the words a run adds after them (`xargs`, a callback's arguments), so that they're read as the rest
   * are: one may be an option, a file the program writes, or the command a wrapper runs.
   */
  withAppended(args: Arg[], ctx: Context, call: Call): Arg[] {
    return (call.open || ctx.open) && args.at(-1) !== appended ? [...args, appended] : args;
  }

  emit(ctx: Context, call: Call, program: string | null, kind: Invocation['kind'], argv: Arg[], parsed: Parsed, path?: string): void {
    if (ctx.silent) return;
    const writes = [...parsed.writes, ...call.writes, ...ctx.writes];
    const reads = [...parsed.reads, ...call.reads, ...ctx.reads];
    // Its redirections' effects are the invocation's, not its spec's: they name where they write.
    const effects = new Set(parsed.effects);
    if (call.writes.length > 0 || ctx.writes.length > 0) effects.add('fs:write');
    if (call.reads.length > 0 || ctx.reads.length > 0) effects.add('fs:read');
    // Bash opens `/dev/tcp/host/port` (and udp) as a connection, not a file: a name only known at run time may be one.
    const redirected = [...call.reads, ...call.writes, ...ctx.reads, ...ctx.writes];
    if (redirected.some((arg) => socket(arg.kind === 'static' ? arg.value : arg.prefix, arg.kind === 'dynamic'))) effects.add('network');
    const open = call.open || ctx.open;
    const invocation: Invocation = {
      program,
      ...(path ? { path } : {}),
      kind,
      argv,
      subcommands: parsed.subcommands,
      ...(parsed.unknownSubcommand ? { unknownSubcommand: parsed.unknownSubcommand } : {}),
      options: parsed.options,
      unknownOptions: parsed.unknownOptions,
      positionals: parsed.positionals,
      maybeOptions: parsed.maybeOptions || open,
      open,
      specified: !!program && !!specFor(program),
      effects: [...effects],
      reads,
      writes,
      outputs: parsed.writes,
      cwd: call.cwd,
      ...(call.home ? { home: call.home } : {}),
      ...(this.files ? { realpaths: this.realpaths([...parsed.positionals, ...writes], ctx, call) } : {}),
      via: ctx.via,
      nesting: ctx.nesting,
      shape: '',
      span: call.span,
      text: this.analysis.source.slice(call.span[0], call.span[1]),
    };
    invocation.shape = shape(invocation);
    if (this.running.size > 0) {
      const key = JSON.stringify(invocation);
      if (this.emitted.has(key)) return;
      this.emitted.add(key);
    }
    this.analysis.invocations.push(invocation);
  }

  finding(ctx: Context, kind: FindingKind, message: string, span: [number, number]): void {
    if (ctx.silent) return;
    const at = ctx.outer ?? span;
    if (this.analysis.findings.some((f) => f.kind === kind && f.message === message && f.span[0] === at[0])) return;
    this.analysis.findings.push({ kind, message, span: at });
  }

  /** A span in the top-level source: the node's own, or the outer word's for code parsed from a string. */
  span(ctx: Context, pos: number, end: number): [number, number] {
    return ctx.outer ?? [pos, end];
  }
}

/** `program subcommand --options <arg>…`: an invocation with its values left out. */
function shape(invocation: Invocation): string {
  const options = Object.entries(invocation.options)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, values]) => (values.some((value) => value !== true) ? `${name}=<v>` : name));
  const positionals = invocation.positionals.map((arg) => (arg.kind === 'static' ? '<arg>' : '<dynamic>'));
  return [invocation.program ?? '<dynamic>', ...invocation.subcommands, ...options, ...positionals].join(' ');
}

/** Whether an object in the JSON `text` (which parses) gives a key more than once. */
function repeatsKey(text: string): boolean {
  const objects: (Set<string> | undefined)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '{') {
      objects.push(new Set());
    } else if (c === '[') {
      objects.push(undefined);
    } else if (c === '}' || c === ']') {
      objects.pop();
    } else if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const colon = /\s*:/y;
      colon.lastIndex = end + 1;
      const keys = objects.at(-1);
      if (keys && colon.test(text)) {
        const key = String(JSON.parse(text.slice(i, end + 1)));
        if (keys.has(key)) return true;
        keys.add(key);
      }
      i = end;
    }
  }
  return false;
}

/** What a `.git` file names: all after `gitdir: `, less the line ends at the end, as git reads it. */
function gitfile(text: string | undefined): string | undefined {
  return text?.startsWith('gitdir: ') ? text.slice('gitdir: '.length).replace(/[\r\n]+$/, '') : undefined;
}

/**
 * Git config as git's own parser reads it: a key may follow its section's header on the line, `;` and `#` start a
 * comment outside double quotes, single quotes are text, a backslash at a line's end goes on to the next, and the
 * spaces around a value aren't part of it. `bad` when git would refuse the file, or this may read it otherwise.
 */
function parseGitConfig(text: string): { entries: { key: string; value: string }[]; bad: boolean } {
  const entries: { key: string; value: string }[] = [];
  let section = '';
  let i = text.startsWith('﻿') ? 1 : 0;
  const bad = () => ({ entries, bad: true });
  const blank = (c: string | undefined) => c === ' ' || c === '\t' || c === '\r' || c === '\v' || c === '\f';
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\n' || blank(c)) {
      i++;
      continue;
    }
    if (c === '#' || c === ';') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '[') {
      const header = /^\[([A-Za-z0-9.-]+)(?:[ \t]+"((?:\\[^\n]|[^"\\\n])*)")?\]/.exec(text.slice(i));
      if (!header) return bad();
      section = header[1]!.toLowerCase();
      if (header[2] !== undefined) section += `.${header[2].replace(/\\(.)/g, '$1').toLowerCase()}`;
      i += header[0].length;
      continue;
    }
    const name = /^[A-Za-z][A-Za-z0-9-]*/.exec(text.slice(i))?.[0];
    if (!name || !section) return bad();
    i += name.length;
    while (blank(text[i])) i++;
    const key = `${section}.${name.toLowerCase()}`;
    if (i >= text.length || text[i] === '\n') {
      entries.push({ key, value: 'true' });
      continue;
    }
    if (text[i] !== '=') return bad();
    i++;
    let value = '';
    let spaces = '';
    let quoted = false;
    for (; i < text.length; i++) {
      const v = text[i]!;
      if (v === '\n') {
        if (quoted) return bad();
        break;
      }
      if (!quoted && (v === ';' || v === '#')) {
        while (i < text.length && text[i] !== '\n') i++;
        break;
      }
      if (!quoted && blank(v)) {
        if (value !== '') spaces += ' ';
        continue;
      }
      value += spaces;
      spaces = '';
      if (v === '"') {
        quoted = !quoted;
        continue;
      }
      if (v !== '\\') {
        value += v;
        continue;
      }
      const next = text[++i];
      if (next === '\r' && text[i + 1] === '\n') i++;
      if (next === '\n' || next === '\r') continue;
      const escaped = next === undefined ? undefined : { n: '\n', t: '\t', b: '\b', '"': '"', '\\': '\\' }[next];
      if (escaped === undefined) return bad();
      value += escaped;
    }
    if (quoted) return bad();
    entries.push({ key, value });
  }
  return { entries, bad: false };
}

/**
 * unbash ends a word at a process substitution (`x=<(f) rm`, `a<(f)b`, `<<< <(f)b`), where Bash keeps one word going:
 * rejoins the words, assignments and redirection targets that touch, then finds the command word again.
 */
function rejoined(command: Command): Command {
  const items = [...command.prefix, ...(command.name ? [command.name] : []), ...command.suffix];
  const joined: typeof items = [];
  for (const item of items) {
    const previous = joined.at(-1);
    const tail = previous?.type === 'Assignment' ? previous.value : previous;
    const next = item.type === 'Assignment' ? asWord(item) : item.type === 'Word' ? item : undefined;
    if (next && previous?.end === item.pos && (previous.type === 'Redirect' || previous.type === 'HereString') && previous.target) {
      // Field by field, as below.
      const { pos, descriptor } = previous;
      const target = touching(previous.target, next);
      joined[joined.length - 1] =
        previous.type === 'Redirect'
          ? { type: 'Redirect', pos, end: next.end, operator: previous.operator, descriptor, target }
          : { type: 'HereString', pos, end: next.end, operator: '<<<', descriptor, target };
      continue;
    }
    if (!previous || tail?.type !== 'Word' || !next || previous.end !== item.pos) {
      joined.push(item);
      continue;
    }
    const value = touching(tail, next);
    // Field by field: unbash's nodes keep `name`, `append` and `index` in getters, which a spread drops.
    joined[joined.length - 1] =
      previous.type === 'Assignment'
        ? {
            type: 'Assignment',
            pos: previous.pos,
            end: next.end,
            text: previous.text + next.text,
            name: previous.name,
            append: previous.append,
            index: previous.index,
            value,
          }
        : value;
  }
  if (joined.length === items.length) return command;
  const prefix: Command['prefix'][number][] = [];
  let name: Word | undefined;
  let at = 0;
  for (; at < joined.length; at++) {
    const item = joined[at]!;
    const assignment = item.type === 'Word' ? asAssignment(item) : item;
    if (assignment) {
      prefix.push(assignment);
    } else if (item.type === 'Word') {
      name = item;
      break;
    }
  }
  const suffix = joined.slice(at + 1);
  return {
    ...command,
    name,
    prefix,
    suffix,
    args: suffix.filter((item) => item.type === 'Word' || item.type === 'Assignment'),
    redirects: [...prefix, ...suffix].filter((item): item is Redirection => item.type !== 'Word' && item.type !== 'Assignment'),
  };
}

/** Two words that touch, as the one word Bash reads. */
function touching(first: Word, second: Word): Word {
  return {
    type: 'Word',
    text: first.text + second.text,
    value: first.value + second.value,
    pos: first.pos,
    end: second.end,
    parts: [...wordParts(first), ...wordParts(second)],
  };
}

function wordParts(word: Word): WordPart[] {
  return word.parts ? [...word.parts] : [{ type: 'Literal', pos: word.pos, end: word.end, text: word.text, value: word.value }];
}

/** An assignment as the word it was written as. */
function asWord(assignment: Assignment): Word | undefined {
  if (assignment.value.type !== 'Word' || assignment.index) return undefined;
  const head = `${assignment.name}${assignment.append ? '+=' : '='}`;
  const name: Word = { type: 'Word', text: head, value: head, pos: assignment.pos, end: assignment.value.pos };
  const { value } = assignment;
  return {
    ...value,
    text: assignment.text,
    value: head + value.value,
    pos: assignment.pos,
    parts: [...wordParts(name), ...wordParts(value)],
  };
}

/** A word in assignment position that Bash reads as one: `name=` or `name+=` unquoted at its start. */
function asAssignment(word: Word): Assignment | undefined {
  const [first, ...rest] = wordParts(word);
  if (first?.type !== 'Literal') return undefined;
  const match = /^([A-Za-z_]\w*)(\+?)=/.exec(first.text);
  if (!match) return undefined;
  const cut = match[0].length;
  const head: WordPart[] =
    first.text.length > cut ? [{ ...first, text: first.text.slice(cut), value: first.value.slice(cut), pos: first.pos + cut }] : [];
  const value: Word = {
    type: 'Word',
    text: word.text.slice(cut),
    value: word.value.slice(cut),
    pos: word.pos + cut,
    end: word.end,
    parts: [...head, ...rest],
  };
  return {
    type: 'Assignment',
    pos: word.pos,
    end: word.end,
    text: word.text,
    name: match[1]!,
    append: match[2] === '+',
    index: undefined,
    value,
  };
}

function argument(item: Command['suffix'][number], lookup: Lookup): Arg[] {
  if (item.type === 'Word') return resolveWord(item, lookup);
  if (item.type !== 'Assignment') return [];
  // As an argument (`alias`, `declare`), Bash expands its braces: `declare v=a{b,c}` declares v twice.
  const braces =
    item.value.type === 'Word' && (item.value.parts?.some((part) => part.type === 'BraceExpansion') || expandsBraces(item.value.text));
  const word = braces ? asWord(item) : undefined;
  if (word) return resolveWord(word, lookup);
  const value = assignmentValue(item, lookup);
  const prefix = `${item.name}${item.append ? '+=' : '='}`;
  return [value.kind === 'static' ? { kind: 'static', value: prefix + value.value } : dynamicArg(item.text, 'variable', false, prefix)];
}

function assignmentValue(assignment: Assignment, lookup: Lookup): Value {
  if (assignment.value.type === 'ArrayValue' || assignment.append || assignment.index) return { kind: 'dynamic' };
  return resolveValue(assignment.value, lookup);
}

/**
 * What Bash stores for `value`, written as `raw`: an unquoted `~`, `~+` or `~-` at its start (or, in an assignment,
 * after a `:`) is expanded as it's assigned, to HOME, the working directory or OLDPWD as they are then, not when the
 * variable is used. A quoted one (`~"+"`, `~+"/x"`) is kept as it is; one written another way is only known at run time.
 */
function tildeExpanded(value: Value, raw: string | undefined, state: State, assignment: boolean): Value {
  if (value.kind !== 'static') return value;
  if (assignment && raw?.includes(':~')) return { kind: 'dynamic' };
  const prefix = (assignment ? /^~[^/:]*/ : /^~[^/]*/).exec(value.value)?.[0];
  if (prefix === undefined) return value;
  if (raw === undefined) return { kind: 'dynamic' };
  const next = raw[prefix.length];
  if (!raw.startsWith(prefix) || (next !== undefined && next !== '/' && !(assignment && next === ':'))) return value;
  const base = prefix === '~' ? homeOf(state) : prefix === '~+' ? state.cwd : undefined;
  return base?.startsWith('/') ? { kind: 'static', value: base + value.value.slice(prefix.length) } : { kind: 'dynamic' };
}

/** Whether a redirection to `path` (or, `partial`, to a path that starts so) may be Bash's `/dev/tcp` or `/dev/udp`. */
function socket(path: string, partial: boolean): boolean {
  const normal = path.replace(/\/+/g, '/');
  if (/^\/dev\/(tcp|udp)\//.test(normal)) return true;
  return partial && ['/dev/tcp/', '/dev/udp/'].some((socket) => socket.startsWith(normal));
}

/** The files redirections read and write, devices left out. A redirection to an fd (`2>&1`) names no file. */
function redirections(list: readonly Redirection[], lookup: Lookup, outputsRead = false): { reads: Arg[]; writes: Arg[] } {
  const reads: Arg[] = [];
  const writes: Arg[] = [];
  for (const redirection of list) {
    if (redirection.type !== 'Redirect' || !redirection.target) continue;
    const operator = redirection.operator;
    const writing = operator !== '<' && operator !== '<&';
    const resolved = resolveWord(redirection.target, lookup);
    // Linux opens `/dev/stdin` and `/dev/fd/N` again as the file that descriptor is on, which may be one opened for
    // reading (`{ … >>/dev/stdin; } < .git/config`): a write there is to a file only known at run time. So are
    // `/dev/stdout` and `/dev/stderr` when the script may open those for reading.
    if (writing && resolved.some((arg) => arg.kind === 'static' && reopens(arg.value, outputsRead)))
      writes.push(dynamicArg('…', 'placeholder', false, ''));
    const targets = resolved.filter((arg) => arg.kind === 'dynamic' || !devices.test(arg.value.replace(/\/+/g, '/')));
    if ((operator === '>&' || operator === '<&') && targets.every((arg) => arg.kind === 'static' && /^(\d+-?|-)$/.test(arg.value)))
      continue;
    if (operator === '<' || operator === '<&' || operator === '<>') reads.push(...targets);
    if (operator !== '<' && operator !== '<&') writes.push(...targets);
  }
  return { reads, writes };
}

/**
 * Variables Bash sets itself as the script runs (or keeps on assignment, as `BASH_ALIASES` keeps the alias table):
 * what was last assigned to one isn't what it holds. Those that are always a number are marked so.
 */
const computed = new Map<string, Value>([
  ...'RANDOM SRANDOM SECONDS EPOCHSECONDS BASH_MONOSECONDS LINENO BASHPID BASH_SUBSHELL HISTCMD PPID UID EUID'
    .split(' ')
    .map((name): [string, Value] => [name, { kind: 'dynamic', numeric: true }]),
  ...'_ BASH_ALIASES BASH_CMDS BASH_ARGC BASH_ARGV BASH_ARGV0 BASH_COMMAND BASH_EXECUTION_STRING BASH_LINENO BASH_REMATCH BASH_SOURCE BASH_TRAPSIG BASH_VERSINFO BASHOPTS SHELLOPTS COLUMNS LINES COPROC DIRSTACK EPOCHREALTIME FUNCNAME GROUPS OLDPWD OPTARG OPTIND PIPESTATUS PWD'
    .split(' ')
    .map((name): [string, Value] => [name, { kind: 'dynamic' }]),
]);
/** Variables Bash starts with the integer attribute: what's assigned to one is evaluated as arithmetic. */
const startingIntegers = ['RANDOM', 'SRANDOM', 'OPTIND', 'HISTCMD', 'BASHPID'];

function lookupIn(state: State): Lookup {
  return (name) => computed.get(name) ?? state.vars.get(name);
}

/** An alias Bash is reading the text of, and where that text ends in the source being parsed. */
interface Expanding {
  name: string;
  end: number;
}

/** The aliases whose text a word starting at `pos` is in. */
function active(ctx: Context, pos: number): string[] {
  return ctx.expanding.filter((alias) => pos < alias.end).map((alias) => alias.name);
}

/** Parts that stop Bash checking words after a blank-ending alias for more aliases. */
const aliasStoppers = new Set(['SimpleExpansion', 'ParameterExpansion', 'CommandExpansion', 'ArithmeticExpansion', 'ProcessSubstitution']);

/** A word as an alias would name it: braces and all, as it's written. */
function aliasName(word: Word): string {
  return word.text.replaceAll('\\\n', '');
}

/** A word aliases may replace: no quotes, escapes or expansions, though braces may be in it. */
function aliasable(word: Word): boolean {
  return plain(word) || !/['"\\$`]/.test(word.text);
}

/** Whether a command's prefix has an assignment before a redirection, after which Bash expands no alias. */
function assignedThenRedirected(command: Command): boolean {
  const first = command.prefix.findIndex((item) => item.type === 'Assignment');
  return first !== -1 && command.prefix.slice(first + 1).some((item) => item.type !== 'Assignment');
}

/** A word with no quotes or expansions, which aliases may replace. */
function plain(word: Word): boolean {
  // A line continuation is gone before Bash reads the word: `c\` and a newline is `c`.
  return !word.parts && word.text.replaceAll('\\\n', '') === word.value;
}

/** The aliases a line starting now is parsed with; `late` for text Bash parses as it expands it (see `Context`). */
function snapshot(state: State, late = false): Aliases {
  const expand = !late || state.posix === false ? state.expandAliases : state.posix || state.expandAliases === false ? false : undefined;
  return { table: new Map(state.aliases), unknown: state.aliasesUnknown, expand };
}

function sorted<V>(map: Map<string, V>): [string, V][] {
  return [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function aliasesKey(table: Map<string, Alias>): unknown[] {
  return sorted(table).map(([name, alias]) => [name, alias.value ?? null, alias.maybe]);
}

const sameAlias = (a: Alias, b: Alias) => a.value === b.value && a.maybe === b.maybe;

function sameAliases(a: Aliases, b: Aliases): boolean {
  return a.unknown === b.unknown && a.expand === b.expand && sameMap(a.table, b.table, sameAlias);
}

function sameMap<K, V>(a: Map<K, V>, b: Map<K, V>, same: (x: V, y: V) => boolean = (x, y) => x === y): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (!b.has(key) || !same(value, b.get(key)!)) return false;
  return true;
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

/** Whether two values of a variable are the same, `undefined` being never assigned. */
function sameValue(x: Value | undefined, y: Value | undefined): boolean {
  if (!x || !y) return x === y;
  return x.kind === 'dynamic' ? y.kind === 'dynamic' && x.numeric === y.numeric : y.kind === 'static' && x.value === y.value;
}

/** Whether two states know the same, for when a loop has settled. */
function equal(a: State, b: State): boolean {
  return (
    sameMap(a.vars, b.vars, sameValue) &&
    sameSet(a.exported, b.exported) &&
    sameMap(a.functions, b.functions, (x, y) => x.maybeUndefined === y.maybeUndefined && sameSet(new Set(x.bodies), new Set(y.bodies))) &&
    sameSet(a.exportedFunctions, b.exportedFunctions) &&
    sameMap(a.aliases, b.aliases, sameAlias) &&
    a.aliasesUnknown === b.aliasesUnknown &&
    a.expandAliases === b.expandAliases &&
    a.posix === b.posix &&
    sameMap(a.hashed, b.hashed) &&
    a.hashUnknown === b.hashUnknown &&
    sameSet(a.refs, b.refs) &&
    sameMap(a.options, b.options) &&
    sameSet(a.maybeExported, b.maybeExported) &&
    sameSet(a.maybeExportedFunctions, b.maybeExportedFunctions) &&
    sameSet(a.disabled, b.disabled) &&
    sameSet(a.integers, b.integers) &&
    sameSet(a.maybeIntegers, b.maybeIntegers) &&
    a.frames.length === b.frames.length &&
    a.frames.every(
      (frame, i) =>
        sameSet(frame.locals, b.frames[i]!.locals) &&
        sameSet(frame.unknown, b.frames[i]!.unknown) &&
        [...frame.locals].every((name) => sameOuter(frame.outer.get(name), b.frames[i]!.outer.get(name))) &&
        sameSaved(frame.saved, b.frames[i]!.saved),
    ) &&
    sameMap(a.cases, b.cases) &&
    a.cwd === b.cwd &&
    !a.failedCwd === !b.failedCwd &&
    a.failedCwd?.cwd === b.failedCwd?.cwd &&
    sameMap(a.later, b.later, (x, y) => sameSet(new Set(x.map((later) => later.key)), new Set(y.map((later) => later.key))))
  );
}

/**
 * A builtin's options as Bash's getopt reads them: letters together (`-tC cmd`), a value in the rest of the word or the
 * next one, and none after `--` or the first word that isn't one. `spec` lists the letters, each followed by `:` when it
 * takes a value. A value only known at run time is `undefined`; `dynamic` when an option word is (it stops there), and
 * `bad` when Bash would refuse them all.
 */
function getopt(
  values: (string | undefined)[],
  spec: string,
): { options: [string, string | undefined][]; rest: number; dynamic: boolean; bad: boolean } {
  const options: [string, string | undefined][] = [];
  let i = 0;
  for (; i < values.length; i++) {
    const value = values[i];
    if (value === undefined) return { options, rest: i, dynamic: true, bad: false };
    if (value === '--') return { options, rest: i + 1, dynamic: false, bad: false };
    if (!value.startsWith('-') || value === '-') break;
    for (let j = 1; j < value.length; j++) {
      const at = spec.indexOf(value[j]!);
      if (at === -1 || value[j] === ':') return { options, rest: i, dynamic: false, bad: true };
      if (spec[at + 1] !== ':') {
        options.push([value[j]!, '']);
        continue;
      }
      if (j + 1 < value.length) options.push([value[j]!, value.slice(j + 1)]);
      else if (i + 1 < values.length) options.push([value[j]!, values[++i]]);
      else return { options, rest: i, dynamic: false, bad: true };
      break;
    }
  }
  return { options, rest: i, dynamic: false, bad: false };
}

/** `text` with its quotes and backslashes removed, as Bash removes them from a word. */
function unquote(text: string): string {
  return text.replaceAll(
    /\$'(?:\\[\s\S]|[^'\\])*'|'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])/g,
    (ansi: string, single?: string, double?: string, escaped?: string) => {
      if (ansi.startsWith("$'")) return decodeAnsiC(ansi);
      return single ?? (double === undefined ? escaped! : double.replaceAll(/\\([$`"\\\n])/g, '$1'));
    },
  );
}

/** Prompt escapes Bash decodes to a character, before it expands the prompt string. */
const promptCharacters: Record<string, string> = { n: '\n', r: '\r', a: '\u0007', e: '\u001b', '[': '', ']': '', '\\': '\\' };

/**
 * A prompt string with its escapes decoded, as Bash decodes them before expanding it: three octal digits are the low
 * byte of their value (`\444` is `$` too), `\n` a newline, and `\\` one backslash, which escapes what follows as it's
 * expanded. `dynamic`: it has an escape whose value is only known at run time (`\s` the shell's name, `\w` the
 * directory, `\$` `#` for root).
 */
function decodePrompt(text: string): { text: string; dynamic: boolean } {
  let dynamic = false;
  const decoded = text.replaceAll(/\\(\\|[0-7]{3}|D\{[^}]*\}|.)/gs, (escape, what: string) => {
    if (/^[0-7]{3}$/.test(what)) return String.fromCharCode(Number.parseInt(what, 8) & 0xff);
    if (what in promptCharacters) return promptCharacters[what]!;
    if (/^(D\{|[dhHjlstT@AuvVwW!#$])/.test(what)) dynamic = true;
    return escape;
  });
  return { text: decoded, dynamic };
}

/** Whether `node` is an expansion that's never closed, which the parser accepts without an error in a here-document. */
function unterminated(node: SyntaxNode): boolean {
  if (node.type === 'CommandExpansion')
    return node.text.startsWith('`') ? node.text.length < 2 || !node.text.endsWith('`') : !node.text.endsWith(')');
  if (node.type === 'ProcessSubstitution') return !node.text.endsWith(')');
  if (node.type === 'ArithmeticExpansion') return !node.text.endsWith(node.text.startsWith('$[') ? ']' : '))');
  if (node.type === 'ParameterExpansion') return node.text.startsWith('${') && !node.text.endsWith('}');
  return false;
}

/** Whether `node` has a here-document the parser found no end for. */
function unclosed(node: SyntaxNode): boolean {
  let found = false;
  const visit = (child: SyntaxNode) => {
    if (child.type === 'HereDoc' && !child.closing) found = true;
    else if (!found) forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** How `declare` changes a value's case: `-u` upper, `-l` lower, `-c` capitalized. */
type Case = 'u' | 'l' | 'c';

/** A value assigned to a variable with a case attribute, as Bash stores it (ASCII only: others follow the locale). */
function cased(value: Value, how: Case | undefined): Value {
  if (value.kind === 'dynamic') return value;
  if (!how || /[^\t\n -~]/.test(value.value)) return { kind: 'dynamic' };
  const text = value.value;
  if (how === 'u') return { kind: 'static', value: text.toUpperCase() };
  if (how === 'l') return { kind: 'static', value: text.toLowerCase() };
  return { kind: 'static', value: text.slice(0, 1).toUpperCase() + text.slice(1).toLowerCase() };
}

/**
 * Puts back the variables a function call made local, as they were when `local` ran (a global assigned before it keeps
 * that value), and options `local -` saved. `outside` is the state the call started in.
 */
function restore(state: State, outside: State): void {
  const frame = state.frames.at(-1);
  state.frames = state.frames.slice(0, -1);
  if (!frame) return;
  const { saved } = frame;
  if (saved) {
    const back = <T>(now: T, then: T) => (saved.maybe && now !== then ? undefined : then);
    // POSIX mode is put back as `set` would, turning `expand_aliases` with it; `expand_aliases` itself isn't, and
    // what Bash then does with it differs from what `shopt` says: one that changed may be either.
    const posix = back(state.posix, saved.posix);
    if (posix !== undefined) {
      setPosix(state, posix);
    } else if (state.posix !== saved.posix) {
      state.posix = undefined;
      state.expandAliases = undefined;
    }
    if (state.expandAliases !== saved.expandAliases) state.expandAliases = undefined;
    for (const [name, then] of saved.set) state.options.set(name, back(option(state, name), then));
  }
  for (const variable of frame.locals) {
    const then = frame.outer.get(variable);
    if (!then) {
      frame.unknown.add(variable);
      continue;
    }
    if (then.value) state.vars.set(variable, then.value);
    else state.vars.delete(variable);
    for (const set of ['exported', 'integers', 'maybeIntegers'] as const) {
      if (then[set]) state[set].add(variable);
      else state[set].delete(variable);
    }
    if (then.cased) state.cases.set(variable, then.case);
    else state.cases.delete(variable);
  }
  // Put back or not: its value is only known at run time, and an attribute only one way has may be there.
  for (const variable of frame.unknown) {
    state.vars.set(variable, { kind: 'dynamic' });
    if (outside.integers.has(variable) !== state.integers.has(variable) || outside.maybeIntegers.has(variable)) {
      state.integers.add(variable);
      state.maybeIntegers.add(variable);
    }
    if (outside.cases.get(variable) !== state.cases.get(variable)) state.cases.set(variable, undefined);
  }
}

/** The options `local -` saves now, in a function. */
function saveOptions(state: State, maybe: boolean): void {
  const frame = state.frames.at(-1);
  if (!frame) return;
  const now: SavedOptions = {
    posix: state.posix,
    expandAliases: state.expandAliases,
    set: new Map([...followed.set].map((name) => [name, option(state, name)])),
    maybe,
  };
  // Saved again, either may be what's put back.
  frame.saved = frame.saved ? joinSaved(frame.saved, { ...now, maybe: true }) : now;
}

/** What a return puts back when `local -` ran one way or the other: a value they differ on may be either. */
function joinSaved(a: SavedOptions | undefined, b: SavedOptions | undefined): SavedOptions | undefined {
  if (!a || !b) return a || b ? { ...(a ?? b)!, set: new Map((a ?? b)!.set), maybe: true } : undefined;
  const same = <T>(x: T, y: T) => (x === y ? x : undefined);
  return {
    posix: same(a.posix, b.posix),
    expandAliases: same(a.expandAliases, b.expandAliases),
    set: new Map([...a.set].map(([name, value]) => [name, same(value, b.set.get(name))])),
    maybe: a.maybe || b.maybe,
  };
}

function sameOuter(a: Outer | undefined, b: Outer | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    sameValue(a.value, b.value) &&
    a.exported === b.exported &&
    a.integers === b.integers &&
    a.maybeIntegers === b.maybeIntegers &&
    a.cased === b.cased &&
    a.case === b.case
  );
}

function sameSaved(a: SavedOptions | undefined, b: SavedOptions | undefined): boolean {
  if (!a || !b) return a === b;
  return a.posix === b.posix && a.expandAliases === b.expandAliases && a.maybe === b.maybe && sameMap(a.set, b.set);
}

/** A variable whose value and attributes are only known at run time. */
function unknownVariable(state: State, variable: string): void {
  state.vars.set(variable, { kind: 'dynamic' });
  state.integers.add(variable);
  state.maybeIntegers.add(variable);
  state.cases.set(variable, undefined);
}

function clone(state: State): State {
  return {
    vars: new Map(state.vars),
    exported: new Set(state.exported),
    functions: new Map([...state.functions].map(([name, fn]) => [name, { bodies: [...fn.bodies], maybeUndefined: fn.maybeUndefined }])),
    exportedFunctions: new Set(state.exportedFunctions),
    aliases: new Map(state.aliases),
    aliasesUnknown: state.aliasesUnknown,
    expandAliases: state.expandAliases,
    posix: state.posix,
    hashed: new Map(state.hashed),
    hashUnknown: state.hashUnknown,
    refs: new Set(state.refs),
    options: new Map(state.options),
    maybeExported: new Set(state.maybeExported),
    maybeExportedFunctions: new Set(state.maybeExportedFunctions),
    disabled: new Set(state.disabled),
    integers: new Set(state.integers),
    maybeIntegers: new Set(state.maybeIntegers),
    frames: state.frames.map((frame) => ({
      locals: new Set(frame.locals),
      outer: new Map(frame.outer),
      unknown: new Set(frame.unknown),
      saved: frame.saved && { ...frame.saved, set: new Map(frame.saved.set) },
    })),
    cases: new Map(state.cases),
    cwd: state.cwd,
    failedCwd: state.failedCwd && { ...state.failedCwd },
    later: new Map([...state.later].map(([slot, code]) => [slot, [...code]])),
  };
}

/**
 * Shell options the walk follows besides POSIX mode and `expand_aliases`, by `set -o` or `shopt` name, each off in a
 * clean shell. `lastpipe` (unless `monitor`) runs a pipeline's last command in the shell, `localvar_inherit` gives a
 * local its outer value, `allexport` exports what's assigned or defined, and `physical` and `cdable_vars` change where
 * `cd` goes.
 */
const followed = {
  set: new Set(['allexport', 'monitor', 'physical']),
  shopt: new Set(['lastpipe', 'localvar_inherit', 'cdable_vars']),
};
/** The letters of `set` (and a shell's options) for the options `shellOption` knows. */
const setLetters: Record<string, string> = { a: 'allexport', m: 'monitor', P: 'physical', k: 'keyword', B: 'braceexpand', H: 'histexpand' };

/** Whether a followed option is on: `undefined` when it may be either. */
function option(state: State, name: string): boolean | undefined {
  return state.options.has(name) ? state.options.get(name) : false;
}

/** With `allexport`, what's assigned or defined is exported: `maybe` holds names exported only if it's on. */
function exportAll(state: State, name: string, exported: Set<string>, maybe: Set<string>): void {
  const on = option(state, 'allexport');
  if (on === true) maybe.delete(name);
  else if (on === false || exported.has(name)) return;
  else maybe.add(name);
  exported.add(name);
}

/** `undefined` when either may be: on when either is. */
function either(a: boolean | undefined, b: boolean | undefined): boolean | undefined {
  return a === true || b === true ? true : a === false && b === false ? false : undefined;
}

/**
 * The shell a script's first line names (`#!/bin/sh`, `#!/usr/bin/env bash`): `sh` with none, as git and the kernel
 * fall back to, and `undefined` for another program.
 */
function interpreter(text: string): 'sh' | 'bash' | undefined {
  if (!text.startsWith('#!')) return 'sh';
  // The rest of the line is one argument: a system shell's, or the shell `env` finds, with no options but `set`'s
  // (`-e`, `-eu`). Others (`env -S`, `bash --rcfile x -i`, `/tmp/sh`) run what the analysis doesn't read.
  const line = /^#![ \t]*(\S+)[ \t]*([^\n]*?)[ \t]*$/m.exec(text);
  if (!line || !isSystemPath(line[1]!)) return undefined;
  const rest = line[2]!;
  const named = basename(line[1]!);
  const program = named === 'env' ? rest : named;
  const options = named === 'env' ? '' : rest;
  if (options !== '' && !/^-[eux]+$/.test(options)) return undefined;
  if (program === 'bash') return 'bash';
  return ['sh', 'dash', 'ash', 'ksh'].includes(program) ? 'sh' : undefined;
}

/** A shell started to run a script: `sh` (dash, or Bash in POSIX mode) expands aliases. */
function shellState(state: State, cwd: string | undefined, shell: 'sh' | 'bash'): State {
  const child = childState(state, cwd);
  if (shell === 'sh') {
    child.expandAliases = true;
    child.posix = true;
  }
  return child;
}

/**
 * A shell started by this one (`bash -c`): exported variables and functions only, aliases off. Only Bash (`bash`)
 * takes the functions: another (`sh` as dash) runs the program of the same name, so with `bash` false each may or may
 * not be defined.
 */
function childState(state: State, cwd: string | undefined, bash = false): State {
  const child = freshState(cwd);
  for (const name of state.exported) {
    const value = state.vars.get(name);
    if (value) child.vars.set(name, state.maybeExported.has(name) ? { kind: 'dynamic' } : value);
  }
  for (const name of state.exportedFunctions) {
    const fn = state.functions.get(name);
    if (fn) child.functions.set(name, !bash || state.maybeExportedFunctions.has(name) ? { ...fn, maybeUndefined: true } : fn);
  }
  child.exported = new Set(state.exported);
  child.maybeExported = new Set(state.maybeExported);
  return child;
}

/**
 * Whether a shell started as `program` expands aliases: `sh`, `dash` and the like do (POSIX says so), as does Bash
 * when interactive, in POSIX mode, or told to; `undefined` when an option only known at run time may say so.
 */
function childAliases(program: string, parsed: Parsed, child: State): boolean | undefined {
  if (program !== 'bash' || parsed.options['-i'] || parsed.options['--posix'] || child.vars.has('POSIXLY_CORRECT')) return true;
  const named = [...(parsed.options['-O'] ?? []), ...(parsed.options['-o'] ?? [])].filter((value) => value !== true);
  if (named.some((value) => value.kind === 'static' && (value.value === 'expand_aliases' || value.value === 'posix'))) return true;
  return named.some((value) => value.kind === 'dynamic') ? undefined : false;
}

/** Whether a shell started as `program` is in POSIX mode: `sh` and the like are, and Bash when told to. */
function childPosix(program: string, parsed: Parsed, child: State): boolean | undefined {
  if (program !== 'bash' || parsed.options['--posix'] || child.vars.has('POSIXLY_CORRECT')) return true;
  const named = (parsed.options['-o'] ?? []).filter((value) => value !== true);
  if (named.some((value) => value.kind === 'static' && value.value === 'posix')) return true;
  return named.some((value) => value.kind === 'dynamic') ? undefined : false;
}

/**
 * POSIX mode turned on or off by `set -o` or `shopt -o`, and with it `expand_aliases`: entering the mode turns it on,
 * leaving it off, and staying changes nothing.
 */
function setPosix(state: State, on: boolean): void {
  const was = state.posix;
  state.posix = on;
  if (was === on) return;
  state.expandAliases = was === undefined && state.expandAliases !== on ? undefined : on;
}

/** `setPosix`, when it may not happen. */
function maybePosix(state: State, on: boolean): void {
  const { posix, expandAliases } = state;
  setPosix(state, on);
  if (state.posix !== posix) state.posix = undefined;
  if (state.expandAliases !== expandAliases) state.expandAliases = undefined;
}

function freshState(cwd: string | undefined): State {
  return {
    vars: new Map(),
    exported: new Set(),
    functions: new Map(),
    exportedFunctions: new Set(),
    aliases: new Map(),
    aliasesUnknown: false,
    expandAliases: false,
    posix: false,
    hashed: new Map(),
    hashUnknown: false,
    refs: new Set(),
    options: new Map(),
    maybeExported: new Set(),
    maybeExportedFunctions: new Set(),
    disabled: new Set(),
    integers: new Set(startingIntegers),
    maybeIntegers: new Set(),
    frames: [],
    cases: new Map(),
    cwd,
    failedCwd: undefined,
    later: new Map(),
  };
}

/** What the status of the command that just ran says about where the shell is (see `State.failedCwd`). */
function decided(state: State, status: 'success' | 'failure' | 'either'): void {
  const failed = state.failedCwd;
  if (!failed) return;
  state.failedCwd = undefined;
  if (status === 'failure') state.cwd = failed.cwd;
  else if (status === 'either' && state.cwd !== failed.cwd) state.cwd = undefined;
}

/** `state` becomes what may hold after any one of `outcomes`. */
function settle(state: State, outcomes: State[]): void {
  const [first, ...rest] = outcomes;
  if (!first) return;
  Object.assign(state, clone(first));
  for (const outcome of rest) join(state, outcome);
}

/** `state` becomes what may hold after it or `other`: what differs becomes unknown, definitions add up. */
function join(state: State, other: State): void {
  for (const name of new Set([...state.vars.keys(), ...other.vars.keys()])) {
    const a = state.vars.get(name);
    const b = other.vars.get(name);
    if (!a || !b || a.kind === 'dynamic' || b.kind === 'dynamic' || a.value !== b.value)
      state.vars.set(name, { kind: 'dynamic', ...(a && b && numericValue(a) && numericValue(b) ? { numeric: true } : {}) });
  }
  // Exported on one way only, a name may not be.
  for (const [mine, theirs, maybe] of [
    [state.exported, other.exported, state.maybeExported],
    [state.exportedFunctions, other.exportedFunctions, state.maybeExportedFunctions],
  ] as const)
    for (const name of new Set([...mine, ...theirs])) if (!mine.has(name) || !theirs.has(name)) maybe.add(name);

  for (const name of other.maybeExported) state.maybeExported.add(name);
  for (const name of other.maybeExportedFunctions) state.maybeExportedFunctions.add(name);
  for (const name of other.exported) state.exported.add(name);
  for (const name of new Set([...state.integers, ...other.integers]))
    if (!state.integers.has(name) || !other.integers.has(name) || other.maybeIntegers.has(name)) state.maybeIntegers.add(name);
  for (const name of other.integers) state.integers.add(name);
  // Local on one way only, a variable may or may not be.
  state.frames.forEach((frame, i) => {
    const theirs = other.frames[i] ?? { locals: new Set<string>(), outer: new Map<string, Outer>(), unknown: new Set<string>() };
    for (const name of new Set([...frame.locals, ...theirs.locals])) {
      if (!frame.locals.has(name) || !theirs.locals.has(name) || !sameOuter(frame.outer.get(name), theirs.outer.get(name)))
        frame.unknown.add(name);
    }
    for (const name of theirs.unknown) frame.unknown.add(name);
    for (const name of frame.unknown) frame.locals.delete(name);
    frame.saved = joinSaved(frame.saved, theirs.saved);
  });
  for (const name of new Set([...state.cases.keys(), ...other.cases.keys()]))
    if (state.cases.get(name) !== other.cases.get(name)) state.cases.set(name, undefined);

  for (const name of new Set([...state.functions.keys(), ...other.functions.keys()])) {
    const a = state.functions.get(name);
    const b = other.functions.get(name);
    const bodies = [...new Set([...(a?.bodies ?? []), ...(b?.bodies ?? [])])];
    state.functions.set(name, { bodies, maybeUndefined: !a || !b || a.maybeUndefined || b.maybeUndefined });
  }
  for (const name of other.exportedFunctions) state.exportedFunctions.add(name);
  for (const name of new Set([...state.aliases.keys(), ...other.aliases.keys()])) {
    const a = state.aliases.get(name);
    const b = other.aliases.get(name);
    const value = a && b ? (a.value === b.value ? a.value : undefined) : (a ?? b)!.value;
    state.aliases.set(name, { value, maybe: !a || !b || a.maybe || b.maybe });
  }
  state.aliasesUnknown ||= other.aliasesUnknown;
  if (state.expandAliases !== other.expandAliases) state.expandAliases = undefined;
  if (state.posix !== other.posix) state.posix = undefined;
  // `undefined` is a path only known at run time, which isn't the same as no `hash -p` at all.
  for (const name of new Set([...state.hashed.keys(), ...other.hashed.keys()])) {
    if (!state.hashed.has(name) || !other.hashed.has(name) || state.hashed.get(name) !== other.hashed.get(name))
      state.hashed.set(name, undefined);
  }
  state.hashUnknown ||= other.hashUnknown;
  for (const name of other.refs) state.refs.add(name);
  for (const name of new Set([...state.options.keys(), ...other.options.keys()]))
    if (option(state, name) !== option(other, name)) state.options.set(name, undefined);
  for (const name of other.disabled) state.disabled.add(name);
  if (state.failedCwd || other.failedCwd) {
    const [mine, theirs] = [(state.failedCwd ?? state).cwd, (other.failedCwd ?? other).cwd];
    state.failedCwd = { cwd: mine === theirs ? mine : undefined };
  }
  if (state.cwd !== other.cwd) state.cwd = undefined;
  // Code set in a slot on either way may be what runs there.
  for (const [slot, code] of other.later) {
    const mine = state.later.get(slot) ?? [];
    state.later.set(slot, [...mine, ...code.filter((later) => !mine.some((other) => other.key === later.key))]);
  }
}

/**
 * A trap's signal as Bash names it: any case, `SIG` optional (except before `EXIT`, `ERR`, `DEBUG` and `RETURN`), `0`
 * for `EXIT`. Other numbers stay numbers, so a reset by number never removes an action set by name.
 */
function signalName(signal: string): string {
  const name = signal.toUpperCase();
  if (name === '0') return 'EXIT';
  return /^SIG(?!(?:EXIT|ERR|DEBUG|RETURN)$)/.test(name) ? name.slice(3) : name;
}

/** What `~` stands for: `$HOME` when it's known and absolute. */
function homeOf(state: State): string | undefined {
  const home = state.vars.get('HOME');
  return home?.kind === 'static' && home.value.startsWith('/') ? home.value : undefined;
}

/** What an arithmetic operand stands for: a number, a variable (whose value is evaluated in turn), the text it expands to, or a value only the run knows. */
type Operand = { kind: 'number' } | { kind: 'name'; name: string } | { kind: 'text'; text: string } | { kind: 'dynamic' };

function operand(value: string, parts: Word['parts'], lookup: Lookup): Operand {
  const element = /^([A-Za-z_]\w*)(?:\[[\s\S]*\])?$/.exec(value);
  if (element) return { kind: 'name', name: element[1]! };
  if (/^(?:0[xX][\da-fA-F]+|\d+(?:#[\w@]+)?)$/.test(value)) return { kind: 'number' };
  const expansion = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/.exec(value);
  if (expansion) return { kind: 'name', name: (expansion[1] ?? expansion[2])! };
  if (/^\$(?:[#?$!]|\{[#?$!]\}|\{#[^}]*\})$/.test(value)) return { kind: 'number' };
  const text = expanded(value, parts, lookup);
  return text === undefined ? { kind: 'dynamic' } : { kind: 'text', text };
}

/** The text an arithmetic operand expands to, before Bash evaluates it, when that's known. */
function expanded(value: string, parts: Word['parts'], lookup: Lookup): string | undefined {
  const simple = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/.exec(value);
  if (simple) {
    const current = lookup((simple[1] ?? simple[2])!);
    return current?.kind === 'static' ? current.value : undefined;
  }
  if (!parts) return value.includes('$') ? undefined : value;
  const resolved = resolveWord({ type: 'Word', pos: 0, end: value.length, text: value, value, parts }, lookup);
  return resolved.length === 1 && resolved[0]!.kind === 'static' ? resolved[0]!.value : undefined;
}

function numericValue(value: Value): boolean {
  return value.kind === 'dynamic' ? value.numeric === true : /^[+-]?(?:0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*)$/.test(value.value.trim());
}
