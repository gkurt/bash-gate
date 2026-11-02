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
import { emptyParsed, normalize, type Parsed } from './argv.ts';
import { Changes, Probe, type FileSystem } from './files.ts';
import { basename, isSystemPath, resolvePath } from './paths.ts';
import { gitConfig, specFor } from './specs.ts';
import type { Analysis, Arg, Effect, FindingKind, Invocation } from './types.ts';
import { dynamicArg, joinStatic, resolveValue, resolveWord, resolveWords, type Lookup, type Value } from './words.ts';

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
  /** `hash -p` paths by name; `undefined` for one set dynamically. */
  hashed: Map<string, string | undefined>;
  /** Builtins turned off with `enable -n`: the name runs the program instead. */
  disabled: Set<string>;
  /** Variables with the integer attribute (`declare -i`): what they're assigned is evaluated as arithmetic. */
  integers: Set<string>;
  /**
   * Variables whose case Bash changes when they're assigned (`declare -u`, `-l`, `-c`): `undefined` when it may or may
   * not, or differently.
   */
  cases: Map<string, Case | undefined>;
  cwd: string | undefined;
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

/** A function definition, with the aliases its body was parsed with. */
interface Body {
  node: FunctionNode;
  aliases: Aliases;
}

/** Where the walk is: the source positions index, and how it got there. */
interface Context {
  source: string;
  /** For code parsed from a string, the span of what holds it in the top-level source. */
  outer?: [number, number];
  aliases: Aliases;
  /** Aliases being expanded, which aren't expanded again in their own text. */
  expanding: string[];
  nesting: string[];
  via: string[];
  depth: number;
  /** Function bodies being called, so recursion stops even when a name is redefined. */
  calls: FunctionNode[];
  /** The variables the innermost of those calls made local: they're put back when it returns. */
  locals?: Set<string>;
  /** Reached through `env`, `sudo`, `xargs`, `exec`…: no aliases, functions or builtins, only programs. */
  externalOnly: boolean;
  /** Files a compound command's redirections write and read, for each command in it. */
  writes: Arg[];
  reads: Arg[];
  /** Walking a loop body once to see what it changes: nothing is recorded. */
  silent: boolean;
  /** Code run with arguments appended (`mapfile -C`, a git shell alias): every command in it may get more. */
  open: boolean;
  /** Runs alongside the rest of the script (`&`, a pipeline, `<(…)`): what it reads may be written by what comes after. */
  concurrent: boolean;
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

const builtins = new Set(
  ': . [ alias bg bind break builtin caller cd command compgen complete compopt continue declare dirs disown echo enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type typeset ulimit umask unalias unset wait'.split(
    ' ',
  ),
);

/** Variables that change what runs or where it's looked up, for the shell or the programs it starts (prompt strings and `PROMPT_COMMAND` are walked as code instead). */
const sensitive =
  /^(PATH|BASH_ENV|ENV|IFS|SHELLOPTS|BASHOPTS|CDPATH|HOME|ZDOTDIR|TMPDIR|XDG_CONFIG_HOME|LD_[A-Z_]+|DYLD_[A-Z_]+|GIT_[A-Z_]+|GH_(PAGER|EDITOR|BROWSER|CONFIG_DIR|PATH)|BROWSER|PAGER|MANPAGER|EDITOR|VISUAL|LESSOPEN|LESSCLOSE|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|SSH_ASKPASS|SUDO_ASKPASS|npm_config_\w+|NPM_CONFIG_\w+)$/;

/** Files a redirection may name without touching the file system. */
const devices = /^\/dev\/(null|stdin|stdout|stderr|tty|fd\/\d+)$/;

/** Statically analyses a Bash script: every program it may run, with what, and what the analysis couldn't follow. */
export function analyze(source: string, environment: Environment = {}): Analysis {
  const script = parse(source);
  const files = environment.fs ? new Probe(environment.fs) : undefined;
  const walk = (silent: boolean, everything?: Written): Walker => {
    const state: State = {
      vars: new Map(Object.entries(environment.env ?? {}).map(([name, value]) => [name, { kind: 'static', value }])),
      exported: new Set(Object.keys(environment.env ?? {})),
      functions: new Map(),
      exportedFunctions: new Set(),
      aliases: new Map(),
      aliasesUnknown: false,
      expandAliases: false,
      hashed: new Map(),
      disabled: new Set(),
      integers: new Set(),
      cases: new Map(),
      cwd: environment.cwd ?? '.',
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
      externalOnly: false,
      writes: [],
      reads: [],
      silent,
      open: false,
      concurrent: false,
    };
    const walker = new Walker({ source, invocations: [], findings: [], needs: [] }, environment.maxDepth ?? 12, files, everything);
    walker.script(script, state, context);
    return walker;
  };
  // Code that runs alongside the rest may read what the script writes after it: a silent first walk finds all of that.
  const everything = files ? walk(true).written : undefined;
  const { analysis } = walk(false, everything);
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

/**
 * Whether a program may write files the analysis can't name: one without a spec, one running code that isn't followed,
 * or one whose spec writes without saying where. Git's own writes are its work tree (`gitWritesTree`) and `.git`, but
 * a clone, a new worktree or an init lands somewhere else.
 */
function writesUnknown(program: string, parsed: Parsed, followed: boolean): boolean {
  if (!specFor(program)) return true;
  const { effects } = parsed;
  if (effects.has('exec:arbitrary') || effects.has('exec:file') || (effects.has('exec:project') && !followed)) return true;
  if (program === 'git')
    return /^(clone|worktree|init)$/.test(parsed.subcommands.join(' ')) || (!followed && gitWritesTree.test(parsed.subcommands.join(' ')));
  return (effects.has('fs:write') || effects.has('fs:delete')) && parsed.writes.length === 0;
}

/** How many times a loop body is walked looking for what it changes before the analysis gives up on it. */
const maxIterations = 32;

/** How many commands the analysis walks in all, so that no input costs more than this. */
const maxWork = 200_000;

class Walker {
  analysis: Analysis;
  maxDepth: number;
  /** Commands walked so far, against `maxWork`. */
  work = 0;
  /** Each function definition once per alias table, so that a loop defining a function settles. */
  bodies = new Map<FunctionNode, Body[]>();
  /** Where each loop settles, by what held when it began (see `loop`). */
  settled = new Map<object, Map<string, State>>();
  ids = new Map<object, number>();
  /** What code that runs later left, by the code, whether it was walked silently, and the state it ran in. */
  ran = new Map<string, State>();
  /** Code that runs later being walked, which doesn't run again inside itself. */
  running = new Set<string>();
  /** What code that runs later emitted, which walking it in another state doesn't emit again. */
  emitted = new Set<string>();
  files: Probe | undefined;
  /**
   * What the script may have written so far, in the order of the walk. The filesystem is shared by every shell the
   * script starts, so this isn't part of a shell's state, and it only grows: a branch's writes count after it.
   */
  written: Written = { contents: new Changes(), links: new Changes() };
  /** How many times `written` grew, so code walked before a write is walked again after it. */
  writes = 0;
  /** Code in strings by its text: walked again, it defines the same functions, so what it does settles. */
  scripts = new Map<string, ParsedScript>();
  /** What the whole script may write, for code that runs alongside the rest. */
  everything: Written | undefined;

  constructor(analysis: Analysis, maxDepth: number, files?: Probe, everything?: Written) {
    this.analysis = analysis;
    this.maxDepth = maxDepth;
    this.files = files;
    this.everything = everything;
  }

  /** `writes` happen: `kind` is what they change for a later read (see `writeKind`). */
  wrote(writes: Arg[], call: Call, kind: 'none' | 'contents' | 'links'): void {
    if (!this.files || kind === 'none' || writes.length === 0) return;
    this.writes++;
    const sets = kind === 'links' ? [this.written.contents, this.written.links] : [this.written.contents];
    for (const arg of writes) {
      const path = arg.kind === 'static' ? resolvePath(call.cwd, arg.value, call.home) : undefined;
      // Through a symlink that's already there, a write lands somewhere else.
      const real = path?.startsWith('/') ? this.files.physical(path) : undefined;
      for (const changes of sets) {
        changes.add(path);
        changes.add(real);
      }
    }
  }

  /** A program writes files no one can name: from here on, every file and real path is unknown. */
  wroteAnything(): void {
    if (!this.files) return;
    this.writes++;
    this.written.contents.add(undefined);
    this.written.links.add(undefined);
  }

  /** Git rewrites the work tree at `root`, files and symlinks, but not its `.git` (`git`). */
  wroteTree(root: string, git: string): void {
    if (!this.files) return;
    if (!root.startsWith('/')) return this.wroteAnything();
    this.writes++;
    const real = this.files.physical(root);
    const realGit = this.files.physical(git);
    for (const changes of [this.written.contents, this.written.links]) {
      changes.addTree(root, git);
      if (real === undefined || realGit === undefined) changes.add(undefined);
      else changes.addTree(real, realGit);
    }
  }

  /** Whether the script may have changed `path` before now: its contents, or (`links`) a symlink on its way. */
  changed(path: string, ctx: Context, kind: keyof Written): boolean {
    const sets = [this.written[kind], ...(ctx.concurrent && this.everything ? [this.everything[kind]] : [])].filter(
      (changes) => !changes.empty,
    );
    if (sets.length === 0) return false;
    const real = path.startsWith('/') ? this.files?.physical(path) : undefined;
    return real === undefined || sets.some((changes) => changes.covers(path) || changes.covers(real));
  }

  /** A file the command reads (Git config, a hook): its text, or `undefined` when it's absent or not known (a finding). */
  read(path: string, ctx: Context, call: Call): string | undefined {
    const text = this.files!.readFile(path);
    if (this.changed(path, ctx, 'contents')) {
      this.finding(ctx, 'unknown-file', `\`${path}\` may be changed by the script before it's read`, call.span);
      return undefined;
    }
    if (text === undefined) this.finding(ctx, 'unknown-file', `What \`${path}\` holds isn't known`, call.span);
    return text ?? undefined;
  }

  /** Where each static path in `args` really is, by its resolved absolute path (see `Invocation.realpaths`). */
  realpaths(args: Arg[], ctx: Context, call: Call): Record<string, string | null> {
    const realpaths: Record<string, string | null> = {};
    if (!call.cwd?.startsWith('/')) return realpaths;
    for (const arg of args) {
      const resolved = arg.kind === 'static' ? resolvePath(call.cwd, arg.value, call.home) : undefined;
      if (!resolved?.startsWith('/') || Object.hasOwn(realpaths, resolved)) continue;
      realpaths[resolved] = this.changed(resolved, ctx, 'links') ? null : (this.files!.physical(resolved) ?? null);
    }
    return realpaths;
  }

  /**
   * Code Bash parses as it runs (a script, `eval`, `bash -c`, a substitution): each line is parsed with the aliases
   * defined when it begins. `first` is the alias table for the first line when it continues one (an alias's text).
   */
  script(script: ParsedScript, state: State, ctx: Context, first?: Aliases): void {
    for (const error of script.errors ?? []) this.finding(ctx, 'parse-error', `Parse error: ${error.message}`, [error.pos, error.pos]);
    this.carriageReturn(ctx.source, ctx);
    // An alias's text leaves out a here-document's body, which is after the command.
    if (!first && unclosed(script)) this.finding(ctx, 'parse-error', 'A here-document is never closed', this.span(ctx, 0, 0));
    let unit = first ? { aliases: first, expanding: ctx.expanding } : undefined;
    let previous: number | undefined;
    for (const statement of script.commands) {
      if (!unit || (previous !== undefined && ctx.source.slice(previous, statement.pos).includes('\n')))
        unit = { aliases: snapshot(state), expanding: [] };
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

  node(node: PipelineNode | AndOr | CommandNode | CompoundList, state: State, ctx: Context): void {
    if (++this.work > maxWork) {
      // Recorded even in a silent walk: what follows isn't walked at all.
      this.alarm('The script is too large for the analysis to follow', [0, this.analysis.source.length]);
      return;
    }
    switch (node.type) {
      case 'CompoundList':
        return this.list(node.commands, state, ctx);
      case 'AndOr': {
        const [first, ...rest] = node.commands;
        if (first) this.node(first, state, ctx);
        for (const command of rest) {
          this.between(state, ctx);
          const branch = clone(state);
          this.node(command, branch, ctx);
          join(state, branch);
        }
        return;
      }
      case 'Pipeline': {
        const together = node.commands.length > 1;
        for (const command of node.commands) {
          const shell = together ? clone(state) : state;
          this.node(command, shell, together ? { ...ctx, concurrent: true } : ctx);
          if (together) this.between(shell, ctx);
        }
        return;
      }
      case 'Command':
        return this.simple(node, state, ctx);
      case 'If': {
        this.list(node.clause.commands, state, ctx);
        const outcomes = [this.branch(state, ctx, (s, c) => this.list(node.then.commands, s, c))];
        for (const elif of node.elif)
          outcomes.push(this.branch(state, ctx, (s, c) => this.list([...elif.clause.commands, ...elif.then.commands], s, c)));
        outcomes.push(node.else ? this.branch(state, ctx, (s, c) => this.list(node.else!.commands, s, c)) : clone(state));
        return settle(state, outcomes);
      }
      case 'For':
      case 'Select': {
        this.substitutions(node.wordlist ?? [], state, ctx);
        const values = (node.wordlist ?? []).flatMap((word) => resolveWord(word, lookupIn(state)));
        const only = values.length === 1 ? values[0] : undefined;
        const value: Value = only?.kind === 'static' ? { kind: 'static', value: only.value } : { kind: 'dynamic' };
        state.vars.set(node.name.value, this.assigned(node.name.value, value, state, ctx, this.at(ctx, state, node), true));
        return this.loop(state, ctx, node, (s, c) => this.list(node.body.commands, s, c));
      }
      case 'ArithmeticFor':
        for (const expression of [node.initialize, node.test, node.update]) if (expression) this.arithmetic(expression, state, ctx);
        return this.loop(state, ctx, node, (s, c) => this.list(node.body.commands, s, c));
      case 'While':
        return this.loop(state, ctx, node, (s, c) => this.list([...node.clause.commands, ...node.body.commands], s, c));
      case 'Case': {
        this.substitutions([node.word, ...node.items.flatMap((item) => item.pattern)], state, ctx);
        const outcomes = node.items.map((item) => this.branch(state, ctx, (s, c) => this.list(item.body.commands, s, c)));
        return settle(state, [...outcomes, clone(state)]);
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
        const files = redirections(node.redirects, lookupIn(state));
        // Bash opens the files before it runs what's in the group, and runs none of it when one can't be opened.
        this.wrote(files.writes, this.at(ctx, state, node), 'contents');
        const inner = { ...ctx, writes: [...ctx.writes, ...files.writes], reads: [...ctx.reads, ...files.reads] };
        if (files.writes.length === 0 && files.reads.length === 0) return this.node(node.command, state, inner);
        return settle(state, [clone(state), this.branch(state, inner, (s, c) => this.node(node.command, s, c))]);
      }
      case 'Function':
        state.functions.set(node.name.value, { bodies: [this.body(node, ctx.aliases)], maybeUndefined: false });
        return;
      case 'Coproc':
        return this.node(node.body, clone(state), { ...ctx, concurrent: true });
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
    const memo = this.settled.get(node) ?? new Map<string, State>();
    this.settled.set(node, memo);
    const key = this.key(state, ctx);
    const known = memo.get(key);
    if (known) {
      Object.assign(state, clone(known));
    } else {
      for (let i = 0; ; i++) {
        const next = clone(state);
        join(next, this.branch(state, { ...ctx, silent: true }, walk));
        if (equal(next, state)) break;
        Object.assign(state, next);
        if (i === maxIterations) {
          this.alarm('A loop changes more than the analysis follows', this.span(ctx, node.pos, node.end));
          break;
        }
      }
      memo.set(key, clone(state));
    }
    // Settled, a silent walk has nothing more to learn: one more would only double the cost at every level.
    if (!ctx.silent) join(state, this.branch(state, ctx, walk));
  }

  /** What a silent walk's outcome depends on: the state, and the parts of the context that change what it does. */
  key(state: State, ctx: Context): string {
    return JSON.stringify([
      this.stateKey(state),
      ctx.depth,
      ctx.externalOnly,
      ctx.calls.map((node) => this.id(node)),
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
      sorted(state.hashed).map(([name, path]) => [name, path ?? null]),
      [...state.disabled].sort(),
      [...state.integers].sort(),
      sorted(state.cases).map(([name, how]) => [name, how ?? null]),
      state.cwd ?? null,
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
  body(node: FunctionNode, aliases: Aliases): Body {
    const known = this.bodies.get(node) ?? [];
    const found = known.find((body) => sameAliases(body.aliases, aliases));
    if (found) return found;
    const body = { node, aliases };
    this.bodies.set(node, [...known, body]);
    return body;
  }

  /** Command substitutions and arithmetic evaluation hidden in `nodes`. */
  substitutions(nodes: readonly SyntaxNode[], state: State, ctx: Context): void {
    const visit = (node: SyntaxNode, ctx: Context) => {
      if (node.type === 'Script') {
        const scriptCtx = node.source === undefined ? ctx : { ...ctx, source: node.source, outer: ctx.outer ?? [node.pos, node.end] };
        this.script(node, clone(state), { ...scriptCtx, nesting: [...ctx.nesting, '$(…)'] });
        return;
      }
      if (node.type === 'ProcessSubstitution') return forEachChild(node, (child) => visit(child, { ...ctx, concurrent: true }));
      if (node.type === 'ArithmeticExpansion') {
        if (node.expression) this.arithmetic(node.expression, state, ctx);
        return;
      }
      if (node.type === 'HereDocBody' && node.parts?.some((part) => part.type === 'ParameterExpansion' && part.text.includes("'"))) {
        // Bash expands the body as if it were in double quotes, so `'` in `${y:-'$(ls)'}` is only text, and `ls` runs.
        // The parser reads it as quoting, but not in a double-quoted string: the body is walked again as one.
        const text = node.parts.map((part) =>
          part.type === 'Literal' ? part.text.replaceAll(/\\[\s\S]|"/g, (m) => (m === '"' ? '\\"' : m)) : part.text,
        );
        this.expansions(text.join(''), state, ctx, this.at(ctx, state, node), 'here-document', true);
      }
      if (node.type === 'ParameterExpansion') {
        if (node.index && node.index.value !== '@' && node.index.value !== '*') this.arithmeticWord(node.index, state, ctx, true);
        if (node.operation?.type === 'Slice') {
          this.arithmeticWord(node.operation.offset, state, ctx, true);
          if (node.operation.length) this.arithmeticWord(node.operation.length, state, ctx, true);
        }
      }
      if (node.type === 'Assignment' && node.value.type === 'Word' && !node.value.parts && /^\(.*[$`<>]/s.test(node.value.text)) {
        // `v=(…)x`: no array, but a string Bash expands, parentheses and all. The parser read it as plain text.
        const where = this.span(ctx, node.pos, node.end);
        this.finding(ctx, 'parse-error', 'An array assignment with text after it, which Bash expands as a string', where);
      }
      if (node.type === 'Assignment' && node.index) this.arithmeticWord(node.index, state, ctx, true);
      if (node.type === 'Assignment' && node.value.type === 'ArrayValue') {
        // `a=([i]=v)`: the subscript is arithmetic, as in `a[i]=v`.
        for (const element of node.value.elements) {
          const subscript = /^\[([\s\S]*?)\]\+?=/.exec(element.text)?.[1];
          if (subscript === undefined) continue;
          this.unquoted(subscript, state, ctx, element);
          this.arithmeticText(subscript, state, ctx, element.text, this.span(ctx, element.pos, element.end));
        }
      }
      if (node.type === 'TestBinary' && ['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(node.operator)) {
        this.arithmeticWord(node.left, state, ctx);
        this.arithmeticWord(node.right, state, ctx);
      }
      forEachChild(node, (child) => visit(child, ctx));
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
    if (text.includes("'") && /[$`]/.test(text)) this.expansions(text, state, ctx, this.at(ctx, state, node), 'arithmetic');
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
        if (variable) writes.push({ variable, numeric: this.numericExpression(expression, state, new Set(seen)) });
        else
          this.finding(ctx, 'sensitive-variable', `Arithmetic assigns a variable named only at run time: ${target.value}`, where(target));
      }
      if (node.type === 'ArithmeticWord') return this.operand(node, reads.get(node) ?? true, state, ctx, seen, where(node));
      forEachChild(node, visit);
    };
    visit(expression);
    for (const { variable, numeric } of writes) {
      const value: Value = { kind: 'dynamic', ...(numeric ? { numeric: true } : {}) };
      state.vars.set(variable, this.assigned(variable, value, state, ctx, this.at(ctx, state, expression), true));
    }
  }

  /** An operand: its subscript is evaluated, and so is the value it reads (`reads`: not the target of a plain `=`). */
  operand(
    word: { value: string; parts?: Word['parts'] },
    reads: boolean,
    state: State,
    ctx: Context,
    seen: Set<string>,
    span: [number, number],
  ): void {
    const subscript = /^[^[]*?\[([\s\S]*)\]\}?$/.exec(word.value)?.[1];
    if (subscript !== undefined && subscript !== '@' && subscript !== '*')
      this.arithmeticText(subscript, state, ctx, word.value, span, seen);
    if (!reads) return;
    const item = operand(word.value, word.parts, lookupIn(state));
    if (item.kind === 'name') this.arithmeticVariable(item.name, state, ctx, span, seen);
    else if (item.kind === 'text' && item.text !== word.value)
      this.arithmeticText(item.text, state, ctx, word.value, span, new Set([...seen, `\0${seen.size}`]));
    else if (item.kind !== 'number')
      this.finding(ctx, 'dynamic-arithmetic', `Arithmetic operand is only known at run time: ${word.value}`, span);
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
    const files = redirections(command.redirects, lookup);
    const span = this.span(ctx, command.pos, command.end);
    const argv = command.name ? [...resolveWord(command.name, lookup), ...command.suffix.flatMap((item) => argument(item, lookup))] : [];
    const call: Call = {
      span,
      writes: files.writes,
      reads: files.reads,
      ...(command.name && plain(command.name) ? { command } : {}),
      noFunctions: false,
      open: false,
      cwd: state.cwd,
      home: homeOf(state),
    };
    for (const assignment of assignments) {
      const value = assignmentValue(assignment, lookup);
      const stored = this.assigned(assignment.name, value, state, ctx, call, argv.length === 0);
      if (argv.length === 0) state.vars.set(assignment.name, stored);
    }
    this.wrote(files.writes, call, 'contents');
    const opens = files.writes.length > 0 || files.reads.length > 0;
    // A file Bash can't open stops the command before it runs, along with what it would change (`alias x=y <nofile`).
    if (argv.length > 0 && opens) return settle(state, [clone(state), this.branch(state, ctx, (s, c) => this.dispatch(argv, s, c, call))]);
    if (argv.length > 0) return this.dispatch(argv, state, ctx, call);
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
      parsed.positionals = argv.slice(1);
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
    if (call.command && !ctx.externalOnly && ctx.aliases.expand !== false && this.alias(name, argv, state, ctx, call)) return;
    const fn = ctx.externalOnly || call.noFunctions ? undefined : state.functions.get(name);
    if (fn) {
      this.emit(ctx, call, name, 'function', argv, emptyParsed());
      const outcomes = fn.bodies.map(({ node, aliases }) => {
        if (ctx.calls.includes(node)) {
          this.finding(ctx, 'too-deep', `Recursive function \`${name}\` cannot be followed further`, call.span);
          return clone(state);
        }
        // The body was parsed, aliases and all, when it was defined.
        const locals = new Set<string>();
        return this.branch(state, { ...ctx, calls: [...ctx.calls, node], locals, aliases, expanding: [] }, (s, c) => {
          this.node(node.body, s, c);
          restore(s, state, locals);
        });
      });
      settle(state, fn.maybeUndefined ? [...outcomes, clone(state)] : outcomes);
      if (!fn.maybeUndefined) return;
    }
    if (!ctx.externalOnly && builtins.has(name) && !state.disabled.has(name)) return this.builtin(name, argv, state, ctx, call);
    this.program(argv, state, ctx, call);
  }

  /**
   * Expands an alias in place of the command word; `true` when that's all that runs. When aliases may be on or off,
   * both ways are walked.
   */
  alias(name: string, argv: Arg[], state: State, ctx: Context, call: Call): boolean {
    const { table, unknown, expand } = ctx.aliases;
    if (!table.has(name) || ctx.expanding.includes(name)) {
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
    const { table, unknown } = ctx.aliases;
    let text = ctx.source.slice(command.pos, command.name!.pos) + value;
    let rest = command.name!.end;
    let last = value;
    const values = [value];
    for (const item of command.suffix) {
      if (!/[ \t]$/.test(last) || item.type !== 'Word' || !plain(item)) break;
      if (!table.has(item.value)) {
        if (unknown) this.finding(ctx, 'unknown-alias', `\`${item.value}\` may be an alias defined at run time`, call.span);
        break;
      }
      const { value: next, maybe } = table.get(item.value)!;
      if (next === undefined || maybe) {
        this.finding(ctx, 'unknown-alias', `\`${item.value}\` may be an alias, or one whose value is only known at run time`, call.span);
        break;
      }
      text += ctx.source.slice(rest, item.pos) + next;
      rest = item.end;
      last = next;
      values.push(next);
    }
    text += ctx.source.slice(rest, command.end);
    const inner = {
      ...ctx,
      source: text,
      outer: call.span,
      nesting: [...ctx.nesting, `alias ${name}`],
      depth: ctx.depth + 1,
      expanding: [...ctx.expanding, name],
    };
    // A here-document the alias's text opens has the lines after the command as its body, which the parser read as
    // commands: a `<<` among them can hide the rest of the script.
    if (values.some((text) => unclosed(this.parse(text))))
      this.finding(ctx, 'parse-error', `An alias opens a here-document, whose body the parser read as commands`, call.span);
    this.script(this.parse(text), state, inner, ctx.aliases);
  }

  builtin(name: string, argv: Arg[], state: State, ctx: Context, call: Call): void {
    const args = argv.slice(1);
    const values = args.map((arg) => (arg.kind === 'static' ? arg.value : undefined));
    const effects: Effect[] = [];
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
        let i = 0;
        for (; i < args.length && values[i]?.startsWith('-'); i++) {
          if (values[i] === '--') {
            i++;
            break;
          }
          if (values[i] === '-a') i++;
        }
        if (i < args.length) return this.dispatch(args.slice(i), state, { ...ctx, externalOnly: true }, { ...call, command: undefined });
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
        effects.push('exec:file');
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
      case 'alias':
        effects.push('shell-state');
        for (const arg of args) {
          if (arg.kind === 'dynamic') {
            state.aliasesUnknown = true;
          } else if (arg.value.includes('=') && !arg.value.startsWith('-')) {
            const equals = arg.value.indexOf('=');
            state.aliases.set(arg.value.slice(0, equals), { value: arg.value.slice(equals + 1), maybe: false });
          }
        }
        break;
      case 'unalias':
        effects.push('shell-state');
        if (values.includes('-a')) state.aliases.clear();
        for (const value of values) if (value) state.aliases.delete(value);
        break;
      case 'shopt': {
        const names = values.filter((value) => value !== undefined && !value.startsWith('-'));
        if (args.some((arg) => arg.kind === 'dynamic')) {
          state.expandAliases = state.expandAliases === true ? true : undefined;
        } else if (names.includes('expand_aliases')) {
          if (values.includes('-s')) state.expandAliases = true;
          if (values.includes('-u')) state.expandAliases = false;
        }
        break;
      }
      case 'set':
        // POSIX mode turns expand_aliases on; leaving it puts back what was there before.
        for (let i = 0; i < args.length && values[i] !== '--' && values[i] !== '-'; i++) {
          const option = values[i] === '-o' || values[i] === '+o' ? args[i + 1] : undefined;
          if (args[i]!.kind === 'dynamic' || option?.kind === 'dynamic')
            state.expandAliases = state.expandAliases === true ? true : undefined;
          else if (option?.kind === 'static' && option.value === 'posix')
            state.expandAliases = values[i] === '-o' ? true : state.expandAliases === false ? false : undefined;
          if (option) i++;
        }
        break;
      case 'hash':
        effects.push('shell-state');
        this.hash(values, state, ctx, call);
        break;
      case 'enable': {
        effects.push('shell-state');
        const disabling = values.includes('-n');
        if (values.includes('-f')) {
          effects.push('exec:file');
          this.finding(ctx, 'loads-code', '`enable -f` loads a builtin from a shared object', call.span);
        }
        for (const value of values) {
          if (value === undefined || value.startsWith('-') || !builtins.has(value)) continue;
          if (disabling) state.disabled.add(value);
          else state.disabled.delete(value);
        }
        break;
      }
      case 'cd':
      case 'pushd': {
        const target = values.find((value) => value === undefined || !value.startsWith('-'));
        const arg = args[values.indexOf(target)];
        if (args.length === 0) state.cwd = homeOf(state) ?? '~';
        else if (arg?.kind === 'static' && arg.value !== '-') state.cwd = resolvePath(state.cwd, arg.value, homeOf(state));
        else state.cwd = undefined;
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
        const flags = options.filter((value) => value?.startsWith('-')).join('');
        // In a function, `local`, and `declare` without -g, make a variable of the call's own, unset until assigned.
        const locals = ctx.calls.length > 0 && (name === 'local' || (name !== 'export' && name !== 'readonly' && !flags.includes('g')));
        for (const arg of args) {
          const text = arg.kind === 'static' ? arg.value : arg.prefix;
          if (text.startsWith('-')) continue;
          const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?(\+?=)?/.exec(text);
          if (!match) continue;
          const variable = match[1]!;
          if (flags.includes('f')) {
            if (name === 'export') state.exportedFunctions.add(variable);
            continue;
          }
          if (locals && !ctx.locals?.has(variable)) {
            ctx.locals?.add(variable);
            // Unset in the shell, while what it starts still sees an exported value from outside.
            state.vars.set(variable, state.exported.has(variable) ? { kind: 'dynamic' } : { kind: 'static', value: '' });
            state.integers.delete(variable);
            state.cases.delete(variable);
          }
          if (name === 'export' || flags.includes('x')) state.exported.add(variable);
          if (flags.includes('i')) state.integers.add(variable);
          // One of -u, -l and -c sets it; two of them together, or +u, +l or +c, turn it off.
          const cases = new Set((['u', 'l', 'c'] as const).filter((flag) => flags.includes(flag)));
          if (cases.size === 1) state.cases.set(variable, [...cases][0]);
          else if (cases.size > 1 || options.some((option) => option?.startsWith('+') && /[ulc]/.test(option)))
            state.cases.delete(variable);
          const value: Value =
            flags.includes('n') || match[2] === '+=' || arg.kind === 'dynamic'
              ? { kind: 'dynamic' }
              : { kind: 'static', value: text.slice(match[0].length) };
          const stored = match[2] ? this.assigned(variable, value, state, ctx, call, true) : value;
          if (match[2] || value.kind === 'dynamic') state.vars.set(variable, stored);
        }
        break;
      }
      case 'unset': {
        const functions = values.includes('-f');
        for (const value of values) {
          if (value === undefined || value.startsWith('-')) continue;
          if (functions) state.functions.delete(value);
          else state.vars.set(value, { kind: 'static', value: '' });
          // Leaving POSIX mode puts back whatever expand_aliases was before.
          if (!functions && value === 'POSIXLY_CORRECT' && state.expandAliases) state.expandAliases = undefined;
        }
        break;
      }
      case 'read':
      case 'getopts':
      case 'mapfile':
      case 'readarray':
      case 'printf':
        this.assigns(name, args, state, ctx, call);
        break;
      case 'let':
        for (const arg of args) {
          if (arg.kind === 'static') this.arithmeticText(arg.value, state, ctx, arg.value, call.span);
          else this.finding(ctx, 'dynamic-arithmetic', 'let evaluates an arithmetic expression only known at run time', call.span);
        }
        break;
      case 'compgen':
      case 'complete': {
        const callback = values.indexOf('-C');
        const code = callback < 0 ? undefined : args[callback + 1];
        if (code?.kind === 'static') this.code(code.value, clone(state), ctx, call, `${name} -C`, true);
        else if (code) this.finding(ctx, 'dynamic-script', `${name} -C runs a string only known at run time`, call.span);
        break;
      }
    }
    const parsed = normalize(args, specFor(name));
    for (const effect of effects) parsed.effects.add(effect);
    if (name === '.' || name === 'source') parsed.reads.push(...args.slice(0, 1));
    this.emit(ctx, call, name, 'builtin', argv, parsed);
    this.wrote(parsed.writes, call, 'contents');
  }

  /** Builtins that set variables from input (`read`, `mapfile`, `printf -v`): those become dynamic. */
  assigns(name: string, args: Arg[], state: State, ctx: Context, call: Call): void {
    const values = args.map((arg) => (arg.kind === 'static' ? arg.value : undefined));
    /** Sets a variable by name; `null` for a name only known at run time, which may be any variable. */
    const set = (variable: string | null | undefined) => {
      if (variable === null) return this.finding(ctx, 'sensitive-variable', `${name} sets a variable named only at run time`, call.span);
      if (!variable) return;
      const base = variable.replace(/\[.*$/, '');
      state.vars.set(base, this.assigned(base, { kind: 'dynamic' }, state, ctx, call, true));
    };
    const named = (i: number) => (args[i]?.kind === 'dynamic' ? null : values[i]);
    if (name === 'printf') {
      if (values.includes('-v')) set(named(values.indexOf('-v') + 1));
      return;
    }
    const positionals: (string | null | undefined)[] = [];
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value?.startsWith('-') && name !== 'getopts') {
        if (/^-[adinNptuCcOs]$/.test(value) && !(name === 'read' && /^-[rs]$/.test(value))) {
          if ((name === 'mapfile' || name === 'readarray') && value === '-C') {
            const code = args[i + 1];
            if (code?.kind === 'static') this.code(code.value, clone(state), ctx, call, `${name} -C`, true);
            else if (code) this.finding(ctx, 'dynamic-script', `${name} -C runs a string only known at run time`, call.span);
          }
          if (name === 'read' && value === '-a') set(named(i + 1));
          i++;
        }
        continue;
      }
      positionals.push(named(i));
    }
    if (name === 'getopts') set(positionals[1]);
    else if (name === 'read') (positionals.length > 0 ? positionals : ['REPLY']).forEach(set);
    else set(positionals[0] === undefined ? 'MAPFILE' : positionals[0]);
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
    if (flags.has('r')) state.hashed.clear();
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
    const parsed = normalize(argv.slice(1), specFor(program));
    if (path && !isSystemPath(path)) parsed.effects.add('exec:file');
    for (const entry of parsed.env) {
      if (entry.kind !== 'static') continue;
      const equals = entry.value.indexOf('=');
      this.assigned(entry.value.slice(0, equals), { kind: 'static', value: entry.value.slice(equals + 1) }, state, ctx, call, false, false);
    }
    this.emit(ctx, call, program, 'external', argv, parsed, path);
    const cwd = parsed.cwd?.kind === 'static' ? resolvePath(call.cwd, parsed.cwd.value, call.home) : parsed.cwd ? undefined : call.cwd;
    // Whether the project code it runs (hooks, npm scripts) was walked, along with what that code writes.
    let followed = false;
    if (program === 'git') {
      for (const config of parsed.configs) this.gitConfigEntry(config, state, ctx, call);
      followed = this.gitProject(cwd, parsed, state, ctx, call);
    } else if (program === 'npm') {
      followed = this.npmScripts(cwd, parsed, state, ctx, call);
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
    const unhashed = () => ({ ...clone(state), hashed: new Map<string, string | undefined>() });
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
      const shell = remote ? freshState(undefined) : childState(state, cwd);
      if (!remote && specFor(program) === specFor('bash')) shell.expandAliases = childAliases(program, parsed, shell);
      this.code(
        script.value,
        shell,
        { ...ctx, via: [...ctx.via, program], externalOnly: false, calls: [] },
        call,
        remote ? `${program} (remote)` : script === stdin ? `${program} <<` : `${program} -c`,
      );
    }
    // After what it reads first: `git config k v` reads the config, then writes it.
    this.wrote(parsed.writes, call, writeKind(program));
    if (writesUnknown(program, parsed, followed)) this.wroteAnything();
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
        { ...ctx, via: [...ctx.via, 'git'], externalOnly: false, calls: [] },
        call,
        `git ${key}`,
        true,
      );
    }
  }

  /** Git config, the work tree's writes and the hooks: `false` when the repository wasn't found, so none were followed. */
  gitProject(cwd: string | undefined, parsed: Parsed, state: State, ctx: Context, call: Call): boolean {
    if (!this.files || !cwd) return false;
    // What isn't known is read as absent, so that one round of fetching asks for everything up to the root.
    const readFile = (path: string) => this.read(path, ctx, call);
    let repoRoot = cwd;
    let gitDir: string | undefined;
    let commonDir: string | undefined;
    let configPath: string | undefined;
    let direct: string | undefined;
    for (let depth = 0; depth < 16; depth++) {
      const candidate = resolvePath(repoRoot, '.git');
      if (!candidate) return false;
      const config = readFile(`${candidate}/config`);
      if (config !== undefined) {
        gitDir = candidate;
        configPath = `${candidate}/config`;
        direct = config;
        break;
      }
      const marker = readFile(candidate);
      const pointer = marker && /^gitdir:\s*(.+?)\s*$/im.exec(marker)?.[1];
      if (pointer) {
        gitDir = resolvePath(repoRoot, pointer) ?? pointer;
        const commonPointer = readFile(`${gitDir}/commondir`)?.trim();
        commonDir = commonPointer ? (resolvePath(gitDir, commonPointer) ?? commonPointer) : gitDir;
        configPath = `${commonDir}/config`;
        direct = readFile(configPath);
        break;
      }
      const parent = resolvePath(repoRoot, '..');
      if (!parent || parent === repoRoot) return false;
      repoRoot = parent;
    }
    if (!gitDir || !configPath) return false;
    const entries: { key: string; value: string }[] = [];
    const visited = new Set<string>();
    const load = (path: string, depth: number): void => {
      if (visited.has(path)) return;
      if (depth > 16) {
        this.finding(ctx, 'exec-config', 'Git config includes exceed the analysis limit', call.span);
        return;
      }
      visited.add(path);
      const text = path === configPath && direct !== undefined ? direct : readFile(path);
      if (text === undefined) return;
      const parsedEntries = parseGitConfig(text);
      for (const entry of parsedEntries) {
        if (entry.key === 'include.path' || (entry.key.startsWith('includeif.') && entry.key.endsWith('.path'))) {
          if (/[${}]/.test(entry.value)) {
            this.finding(ctx, 'exec-config', `Git config include path is dynamic: ${entry.value}`, call.span);
            continue;
          }
          const base = path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '.';
          load(resolvePath(base, entry.value) ?? `${base}/${entry.value}`, depth + 1);
        } else {
          entries.push(entry);
        }
      }
    };
    load(configPath, 0);
    let hooksPath: string | undefined;
    for (const entry of entries) {
      const risk = gitConfig(entry.key, entry.value);
      if (risk) this.gitConfigEntry({ kind: 'static', value: `${entry.key}=${entry.value}` }, state, ctx, call);
      if (entry.key.toLowerCase() === 'core.hookspath') hooksPath = entry.value;
    }

    if (gitWritesTree.test(parsed.subcommands.join(' '))) this.wroteTree(repoRoot, resolvePath(repoRoot, '.git')!);
    const subcommand = parsed.subcommands.at(-1);
    if (!subcommand) return true;
    const hooks: Record<string, string[]> = {
      commit: ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'],
      push: ['pre-push'],
      checkout: ['post-checkout'],
      switch: ['post-checkout'],
      merge: ['pre-merge-commit', 'prepare-commit-msg', 'post-merge'],
      rebase: ['pre-rebase', 'post-rewrite'],
      'cherry-pick': ['pre-commit', 'prepare-commit-msg', 'post-commit'],
      revert: ['pre-commit', 'prepare-commit-msg', 'post-commit'],
      am: ['applypatch-msg', 'pre-applypatch', 'post-applypatch'],
    };
    const names = hooks[subcommand];
    if (!names) return true;
    const directory = hooksPath ? (resolvePath(repoRoot, hooksPath) ?? hooksPath) : `${commonDir ?? gitDir}/hooks`;
    for (const name of names) {
      if (parsed.options['--no-verify'] && ['pre-commit', 'commit-msg', 'pre-push'].includes(name)) continue;
      const path = `${directory}/${name}`;
      const script = readFile(path);
      if (script !== undefined) this.code(script, childState(state, repoRoot), ctx, call, `git hook ${name}`);
    }
    return true;
  }

  /** The package.json scripts `npm run` and the like run: `false` when they weren't followed. */
  npmScripts(cwd: string | undefined, parsed: Parsed, state: State, ctx: Context, call: Call): boolean {
    if (!this.files || !cwd) return false;
    const manifest = this.read(`${cwd}/package.json`, ctx, call);
    if (manifest === undefined) return false;
    let packageJson: unknown;
    try {
      packageJson = JSON.parse(manifest);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.finding(ctx, 'exec-config', 'package.json is invalid JSON; npm scripts cannot be inspected', call.span);
      return false;
    }

    if (
      typeof packageJson !== 'object' ||
      packageJson === null ||
      !('scripts' in packageJson) ||
      typeof packageJson.scripts !== 'object' ||
      packageJson.scripts === null
    ) {
      this.finding(ctx, 'exec-config', 'package.json scripts are not a readable object', call.span);
      return false;
    }

    const verb = parsed.subcommands[0];
    const name = verb === 'run' ? parsed.positionals[0] : undefined;
    if (name?.kind === 'dynamic') return false;
    // Without a restart script, `npm restart` runs stop and start: each of them may.
    const names = name
      ? [name.value]
      : verb === 'restart'
        ? ['restart', 'stop', 'start']
        : verb === 'test' || verb === 'start' || verb === 'stop'
          ? [verb]
          : [];
    if (names.length === 0) return false;
    const scripts = packageJson.scripts as Record<string, unknown>;
    for (const scriptName of names.flatMap((name) => [`pre${name}`, name, `post${name}`])) {
      const script = scripts[scriptName];
      if (typeof script !== 'string') {
        if (script !== undefined) this.finding(ctx, 'exec-config', `npm script ${scriptName} is not a string`, call.span);
        continue;
      }
      this.code(script, childState(state, cwd), ctx, call, `npm ${scriptName}`);
    }
    return true;
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

  /** Code in a string (`bash -c`, `eval`, `trap`, an alias): parsed and walked in `state`. */
  code(text: string, state: State, ctx: Context, call: Call, label: string, open = false): void {
    if (ctx.depth >= this.maxDepth)
      return this.finding(ctx, 'too-deep', `Code nests deeper than the analysis follows (${label})`, call.span);
    this.script(this.parse(text), state, {
      ...ctx,
      source: text,
      outer: call.span,
      nesting: [...ctx.nesting, label],
      depth: ctx.depth + 1,
      writes: [],
      reads: [],
      open: ctx.open || open,
    });
  }

  /**
   * `variable` set to `value`, in the shell itself (`shell`) or in the environment of what it runs. Some variables
   * change what runs, a finding. Prompt strings and `PROMPT_COMMAND` hold code, which is walked when it's known: in
   * the shell, as code that runs later (see `between`); for what it runs, now. An integer variable's value is
   * evaluated first when Bash itself assigns it (`bash`); the result is what it holds.
   */
  assigned(variable: string, value: Value, state: State, ctx: Context, call: Call, shell: boolean, bash = true): Value {
    if (shell && variable === 'POSIXLY_CORRECT') state.expandAliases = true;
    const prompt = /^PS[0124]$/.test(variable);
    if ((prompt || variable === 'PROMPT_COMMAND') && value.kind === 'static') {
      const text = value.value;
      const walk: Later['walk'] = (s, silent) =>
        prompt ? this.expansions(text, s, { ...ctx, silent }, call, variable) : this.code(text, s, { ...ctx, silent }, call, variable);
      if (shell) this.later(state, [variable], variable, text, call, walk);
      else walk(clone(state), ctx.silent);
    } else if (prompt || variable === 'PROMPT_COMMAND' || sensitive.test(variable)) {
      this.finding(ctx, 'sensitive-variable', `Setting ${variable} changes what runs or how`, call.span);
    }
    if (bash && state.cases.has(variable)) value = cased(value, state.cases.get(variable));
    if (!bash || !state.integers.has(variable)) return value;
    // An integer variable evaluates what it's assigned as arithmetic, so that's what it holds.
    if (value.kind === 'static')
      return { kind: 'dynamic', ...(this.arithmeticText(value.value, state, ctx, value.value, call.span) ? { numeric: true } : {}) };

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
    const inner = { ...ctx, source, outer: call.span, nesting: [...ctx.nesting, label], depth: ctx.depth + 1, writes: [], reads: [] };
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

  emit(ctx: Context, call: Call, program: string | null, kind: Invocation['kind'], argv: Arg[], parsed: Parsed, path?: string): void {
    if (ctx.silent) return;
    const writes = [...parsed.writes, ...call.writes, ...ctx.writes];
    const reads = [...parsed.reads, ...call.reads, ...ctx.reads];
    if (call.writes.length > 0 || ctx.writes.length > 0) parsed.effects.add('fs:write');
    if (call.reads.length > 0 || ctx.reads.length > 0) parsed.effects.add('fs:read');
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
      positionals: open ? [...parsed.positionals, dynamicArg('…', 'stdin', true, '')] : parsed.positionals,
      maybeOptions: parsed.maybeOptions || open,
      open,
      specified: !!program && !!specFor(program),
      effects: [...parsed.effects],
      reads,
      writes,
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

function parseGitConfig(text: string): { key: string; value: string }[] {
  const entries: { key: string; value: string }[] = [];
  let section = '';
  let subsection = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    const header = /^\[([^\s\]]+)(?:\s+"((?:\\.|[^"])*)")?\]$/.exec(line);
    if (header) {
      section = header[1]!.toLowerCase();
      subsection = header[2]?.replace(/\\(.)/g, '$1').toLowerCase() ?? '';
      continue;
    }
    const setting = /^([A-Za-z][A-Za-z0-9.-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!setting || !section) continue;
    const value = (setting[2] ?? 'true')
      .replace(/^\s*"(.*)"\s*$/, '$1')
      .replace(/^\s*'(.*)'\s*$/, '$1')
      .replace(/\\(.)/g, '$1')
      .trim();
    const key = subsection ? `${section}.${subsection}.${setting[1]!.toLowerCase()}` : `${section}.${setting[1]!.toLowerCase()}`;
    entries.push({ key, value });
  }
  return entries;
}

/**
 * unbash ends a word at a process substitution (`x=<(f) rm`, `a<(f)b`), where Bash keeps one word going: rejoins
 * the words and assignments that touch, then finds the command word again.
 */
function rejoined(command: Command): Command {
  const items = [...command.prefix, ...(command.name ? [command.name] : []), ...command.suffix];
  const joined: typeof items = [];
  for (const item of items) {
    const previous = joined.at(-1);
    const tail = previous?.type === 'Assignment' ? previous.value : previous;
    const next = item.type === 'Assignment' ? asWord(item) : item.type === 'Word' ? item : undefined;
    if (!previous || tail?.type !== 'Word' || !next || previous.end !== item.pos) {
      joined.push(item);
      continue;
    }
    const value: Word = {
      type: 'Word',
      text: tail.text + next.text,
      value: tail.value + next.value,
      pos: tail.pos,
      end: next.end,
      parts: [...wordParts(tail), ...wordParts(next)],
    };
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
    redirects: command.redirects,
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
  const value = assignmentValue(item, lookup);
  const prefix = `${item.name}${item.append ? '+=' : '='}`;
  return [value.kind === 'static' ? { kind: 'static', value: prefix + value.value } : dynamicArg(item.text, 'variable', false, prefix)];
}

function assignmentValue(assignment: Assignment, lookup: Lookup): Value {
  if (assignment.value.type === 'ArrayValue' || assignment.append || assignment.index) return { kind: 'dynamic' };
  return resolveValue(assignment.value, lookup);
}

/** The files redirections read and write, devices left out. A redirection to an fd (`2>&1`) names no file. */
function redirections(list: readonly Redirection[], lookup: Lookup): { reads: Arg[]; writes: Arg[] } {
  const reads: Arg[] = [];
  const writes: Arg[] = [];
  for (const redirection of list) {
    if (redirection.type !== 'Redirect' || !redirection.target) continue;
    const targets = resolveWord(redirection.target, lookup).filter((arg) => arg.kind === 'dynamic' || !devices.test(arg.value));
    const operator = redirection.operator;
    if ((operator === '>&' || operator === '<&') && targets.every((arg) => arg.kind === 'static' && /^(\d+-?|-)$/.test(arg.value)))
      continue;
    if (operator === '<' || operator === '<&' || operator === '<>') reads.push(...targets);
    if (operator !== '<' && operator !== '<&') writes.push(...targets);
  }
  return { reads, writes };
}

function lookupIn(state: State): Lookup {
  return (name) => state.vars.get(name);
}

/** A word with no quotes or expansions, which aliases may replace. */
function plain(word: Word): boolean {
  return !word.parts && word.text === word.value;
}

/** The aliases a line starting now is parsed with. */
function snapshot(state: State): Aliases {
  return { table: new Map(state.aliases), unknown: state.aliasesUnknown, expand: state.expandAliases };
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

/** Whether two states know the same, for when a loop has settled. */
function equal(a: State, b: State): boolean {
  return (
    sameMap(a.vars, b.vars, (x, y) =>
      x.kind === 'dynamic' ? y.kind === 'dynamic' && x.numeric === y.numeric : y.kind === 'static' && x.value === y.value,
    ) &&
    sameSet(a.exported, b.exported) &&
    sameMap(a.functions, b.functions, (x, y) => x.maybeUndefined === y.maybeUndefined && sameSet(new Set(x.bodies), new Set(y.bodies))) &&
    sameSet(a.exportedFunctions, b.exportedFunctions) &&
    sameMap(a.aliases, b.aliases, sameAlias) &&
    a.aliasesUnknown === b.aliasesUnknown &&
    a.expandAliases === b.expandAliases &&
    sameMap(a.hashed, b.hashed) &&
    sameSet(a.disabled, b.disabled) &&
    sameSet(a.integers, b.integers) &&
    sameMap(a.cases, b.cases) &&
    a.cwd === b.cwd &&
    sameMap(a.later, b.later, (x, y) => sameSet(new Set(x.map((later) => later.key)), new Set(y.map((later) => later.key))))
  );
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

/** Puts back the variables a function call made local, as they were before it (`outside`). */
function restore(state: State, outside: State, locals: Set<string>): void {
  for (const variable of locals) {
    const value = outside.vars.get(variable);
    if (value) state.vars.set(variable, value);
    else state.vars.delete(variable);
    for (const set of ['exported', 'integers'] as const) {
      if (outside[set].has(variable)) state[set].add(variable);
      else state[set].delete(variable);
    }
    if (outside.cases.has(variable)) state.cases.set(variable, outside.cases.get(variable));
    else state.cases.delete(variable);
  }
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
    hashed: new Map(state.hashed),
    disabled: new Set(state.disabled),
    integers: new Set(state.integers),
    cases: new Map(state.cases),
    cwd: state.cwd,
    later: new Map([...state.later].map(([slot, code]) => [slot, [...code]])),
  };
}

/** A shell started by this one (`bash -c`): exported variables and functions only, aliases off. */
function childState(state: State, cwd: string | undefined): State {
  const child = freshState(cwd);
  for (const name of state.exported) {
    const value = state.vars.get(name);
    if (value) child.vars.set(name, value);
  }
  for (const name of state.exportedFunctions) {
    const fn = state.functions.get(name);
    if (fn) child.functions.set(name, fn);
  }
  child.exported = new Set(state.exported);
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

function freshState(cwd: string | undefined): State {
  return {
    vars: new Map(),
    exported: new Set(),
    functions: new Map(),
    exportedFunctions: new Set(),
    aliases: new Map(),
    aliasesUnknown: false,
    expandAliases: false,
    hashed: new Map(),
    disabled: new Set(),
    integers: new Set(),
    cases: new Map(),
    cwd,
    later: new Map(),
  };
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
  for (const name of other.exported) state.exported.add(name);
  for (const name of other.integers) state.integers.add(name);
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
  // `undefined` is a path only known at run time, which isn't the same as no `hash -p` at all.
  for (const name of new Set([...state.hashed.keys(), ...other.hashed.keys()])) {
    if (!state.hashed.has(name) || !other.hashed.has(name) || state.hashed.get(name) !== other.hashed.get(name))
      state.hashed.set(name, undefined);
  }

  for (const name of other.disabled) state.disabled.add(name);
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
