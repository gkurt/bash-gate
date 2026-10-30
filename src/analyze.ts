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
} from 'unbash';
import { emptyParsed, normalize, type Parsed } from './argv.ts';
import { basename, isSystemPath, resolvePath } from './paths.ts';
import { gitConfig, specFor } from './specs.ts';
import type { Analysis, Arg, Effect, FindingKind, Invocation } from './types.ts';
import { dynamicArg, joinStatic, resolveValue, resolveWord, resolveWords, type Lookup, type Value } from './words.ts';

export interface AnalyzeOptions {
  /** The absolute directory the script starts in. Without it, paths stay relative to wherever that is. */
  cwd?: string;
  /** Variables the shell starts with. Any other variable read before it's set is dynamic. */
  env?: Record<string, string>;
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
  cwd: string | undefined;
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
  /** Reached through `env`, `sudo`, `xargs`, `exec`…: no aliases, functions or builtins, only programs. */
  externalOnly: boolean;
  /** Files a compound command's redirections write and read, for each command in it. */
  writes: Arg[];
  reads: Arg[];
  /** Walking a loop body once to see what it changes: nothing is recorded. */
  silent: boolean;
  /** Code run with arguments appended (`mapfile -C`, a git shell alias): every command in it may get more. */
  open: boolean;
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
  /^(PATH|BASH_ENV|ENV|IFS|SHELLOPTS|BASHOPTS|CDPATH|HOME|ZDOTDIR|TMPDIR|XDG_CONFIG_HOME|LD_[A-Z_]+|DYLD_[A-Z_]+|GIT_[A-Z_]+|PAGER|MANPAGER|EDITOR|VISUAL|LESSOPEN|LESSCLOSE|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|SSH_ASKPASS|SUDO_ASKPASS|npm_config_\w+|NPM_CONFIG_\w+)$/;

/** Files a redirection may name without touching the file system. */
const devices = /^\/dev\/(null|stdin|stdout|stderr|tty|fd\/\d+)$/;

/** Statically analyses a Bash script: every program it may run, with what, and what the analysis couldn't follow. */
export function analyze(source: string, options: AnalyzeOptions = {}): Analysis {
  const analysis: Analysis = { source, invocations: [], findings: [] };
  const state: State = {
    vars: new Map(Object.entries(options.env ?? {}).map(([name, value]) => [name, { kind: 'static', value }])),
    exported: new Set(Object.keys(options.env ?? {})),
    functions: new Map(),
    exportedFunctions: new Set(),
    aliases: new Map(),
    aliasesUnknown: false,
    expandAliases: false,
    hashed: new Map(),
    disabled: new Set(),
    cwd: options.cwd ?? '.',
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
    silent: false,
    open: false,
  };
  new Walker(analysis, options.maxDepth ?? 12).script(parse(source), state, context);
  return analysis;
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

  constructor(analysis: Analysis, maxDepth: number) {
    this.analysis = analysis;
    this.maxDepth = maxDepth;
  }

  /**
   * Code Bash parses as it runs (a script, `eval`, `bash -c`, a substitution): each line is parsed with the aliases
   * defined when it begins. `first` is the alias table for the first line when it continues one (an alias's text).
   */
  script(script: ParsedScript, state: State, ctx: Context, first?: Aliases): void {
    for (const error of script.errors ?? []) this.finding(ctx, 'parse-error', `Parse error: ${error.message}`, [error.pos, error.pos]);
    let unit = first ? { aliases: first, expanding: ctx.expanding } : undefined;
    let previous: number | undefined;
    for (const statement of script.commands) {
      if (!unit || (previous !== undefined && ctx.source.slice(previous, statement.pos).includes('\n'))) unit = { aliases: snapshot(state), expanding: [] };
      this.node(statement.command, statement.background ? clone(state) : state, { ...ctx, ...unit });
      previous = statement.end;
    }
  }

  list(statements: readonly Statement[], state: State, ctx: Context): void {
    for (const statement of statements) this.node(statement.command, statement.background ? clone(state) : state, ctx);
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
          const branch = clone(state);
          this.node(command, branch, ctx);
          join(state, branch);
        }
        return;
      }
      case 'Pipeline':
        for (const command of node.commands) this.node(command, node.commands.length > 1 ? clone(state) : state, ctx);
        return;
      case 'Command':
        return this.simple(node, state, ctx);
      case 'If': {
        this.list(node.clause.commands, state, ctx);
        const outcomes = [this.branch(state, ctx, (s, c) => this.list(node.then.commands, s, c))];
        for (const elif of node.elif) outcomes.push(this.branch(state, ctx, (s, c) => this.list([...elif.clause.commands, ...elif.then.commands], s, c)));
        outcomes.push(node.else ? this.branch(state, ctx, (s, c) => this.list(node.else!.commands, s, c)) : clone(state));
        return settle(state, outcomes);
      }
      case 'For':
      case 'Select': {
        this.substitutions(node.wordlist ?? [], state, ctx);
        const values = (node.wordlist ?? []).flatMap((word) => resolveWord(word, lookupIn(state)));
        const only = values.length === 1 ? values[0] : undefined;
        const value: Value = only?.kind === 'static' ? { kind: 'static', value: only.value } : { kind: 'dynamic' };
        this.assigned(node.name.value, value, state, ctx, this.at(ctx, state, node), true);
        state.vars.set(node.name.value, value);
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
        return this.node(node.command, state, { ...ctx, writes: [...ctx.writes, ...files.writes], reads: [...ctx.reads, ...files.reads] });
      }
      case 'Function':
        state.functions.set(node.name.value, { bodies: [this.body(node, ctx.aliases)], maybeUndefined: false });
        return;
      case 'Coproc':
        return this.node(node.body, clone(state), ctx);
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
    if (known) Object.assign(state, clone(known));
    else {
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
    const sorted = <V>(map: Map<string, V>) => [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const aliases = (table: Map<string, Alias>) => sorted(table).map(([name, alias]) => [name, alias.value ?? null, alias.maybe]);
    return JSON.stringify([
      sorted(state.vars),
      [...state.exported].sort(),
      sorted(state.functions).map(([name, fn]) => [name, fn.maybeUndefined, fn.bodies.map((body) => this.id(body)).sort()]),
      [...state.exportedFunctions].sort(),
      aliases(state.aliases),
      state.aliasesUnknown,
      state.expandAliases ?? null,
      sorted(state.hashed).map(([name, path]) => [name, path ?? null]),
      [...state.disabled].sort(),
      state.cwd ?? null,
      ctx.depth,
      ctx.externalOnly,
      ctx.calls.map((node) => this.id(node)),
      aliases(ctx.aliases.table),
      ctx.aliases.unknown,
      ctx.aliases.expand ?? null,
      ctx.expanding,
    ]);
  }

  id(object: object): number {
    let id = this.ids.get(object);
    if (id === undefined) this.ids.set(object, (id = this.ids.size));
    return id;
  }

  /** A finding recorded even in a silent walk, for when the analysis stops short and a later walk won't see why. */
  alarm(message: string, span: [number, number]): void {
    if (!this.analysis.findings.some((finding) => finding.message === message)) this.analysis.findings.push({ kind: 'too-deep', message, span });
  }

  /** A call for something that isn't a simple command (a `for` loop, arithmetic), for where findings point. */
  at(ctx: Context, state: State, node: { pos: number; end: number }): Call {
    return { span: this.span(ctx, node.pos, node.end), writes: [], reads: [], noFunctions: false, open: false, cwd: state.cwd, home: homeOf(state) };
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

  /** Command and process substitutions anywhere in `nodes`, each run in a subshell of its own. */
  substitutions(nodes: readonly SyntaxNode[], state: State, ctx: Context): void {
    const visit = (node: SyntaxNode) => {
      if (node.type !== 'Script') return forEachChild(node, visit);
      const scriptCtx = node.source === undefined ? ctx : { ...ctx, source: node.source, outer: ctx.outer ?? [node.pos, node.end] };
      this.script(node, clone(state), { ...scriptCtx, nesting: [...ctx.nesting, '$(…)'] });
    };
    for (const node of nodes) visit(node);
  }

  /** Arithmetic runs the substitutions in it (even in array subscripts), and its assignments change variables. */
  arithmetic(expression: ArithmeticExpression, state: State, ctx: Context): void {
    this.substitutions([expression], state, ctx);
    const visit = (node: SyntaxNode) => {
      if (node.type === 'Script') return;
      const target =
        node.type === 'ArithmeticBinary' && /^([-+*/%&|^]|<<|>>)?=$/.test(node.operator)
          ? node.left
          : node.type === 'ArithmeticUnary' && (node.operator === '++' || node.operator === '--')
            ? node.operand
            : undefined;
      if (target?.type === 'ArithmeticWord') {
        const variable = target.value.replace(/\[.*$/, '');
        this.assigned(variable, { kind: 'dynamic' }, state, ctx, this.at(ctx, state, expression), true);
        state.vars.set(variable, { kind: 'dynamic' });
      }
      forEachChild(node, visit);
    };
    visit(expression);
  }

  simple(command: Command, state: State, ctx: Context): void {
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
      this.assigned(assignment.name, value, state, ctx, call, !argv.length);
      if (!argv.length) state.vars.set(assignment.name, value);
    }
    if (argv.length) return this.dispatch(argv, state, ctx, call);
    if (files.writes.length || files.reads.length) this.emit(ctx, call, ':', 'builtin', [{ kind: 'static', value: ':' }], emptyParsed());
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
      return this.emit(ctx, call, null, 'external', argv, parsed);
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
        return this.branch(state, { ...ctx, calls: [...ctx.calls, node], aliases, expanding: [] }, (s, c) => this.node(node.body, s, c));
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
    if (expand && !maybe) expanded(state, ctx);
    else settle(state, [this.branch(state, ctx, expanded), this.branch(state, ctx, (s, c) => this.dispatch(argv, s, c, { ...call, command: undefined }))]);
    return true;
  }

  /**
   * Bash puts an alias's text in place of the command word and parses the command again. When the text ends in a
   * blank, the next word is expanded too if it's an alias.
   */
  expandAlias(name: string, value: string, command: Command, state: State, ctx: Context, call: Call): void {
    if (ctx.depth >= this.maxDepth) return this.finding(ctx, 'too-deep', `Aliases nest deeper than the analysis follows (${name})`, call.span);
    const { table, unknown } = ctx.aliases;
    let text = ctx.source.slice(command.pos, command.name!.pos) + value;
    let rest = command.name!.end;
    let last = value;
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
    }
    text += ctx.source.slice(rest, command.end);
    const inner = { ...ctx, source: text, outer: call.span, nesting: [...ctx.nesting, `alias ${name}`], depth: ctx.depth + 1, expanding: [...ctx.expanding, name] };
    this.script(parse(text), state, inner, ctx.aliases);
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
        if (!lookupOnly && i < args.length) return this.dispatch(args.slice(i), state, ctx, { ...call, command: undefined, noFunctions: true });
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
        if (args.length < 2 || values[0]?.startsWith('-')) break;
        const action = args[0]!;
        if (action.kind === 'dynamic') this.finding(ctx, 'dynamic-script', 'trap runs a string only known at run time', call.span);
        else if (action.value !== '' && action.value !== '-') this.code(action.value, clone(state), ctx, call, 'trap');
        break;
      }
      case 'alias':
        effects.push('shell-state');
        for (const arg of args) {
          if (arg.kind === 'dynamic') state.aliasesUnknown = true;
          else if (arg.value.includes('=') && !arg.value.startsWith('-')) {
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
        if (args.some((arg) => arg.kind === 'dynamic')) state.expandAliases = state.expandAliases === true ? true : undefined;
        else if (names.includes('expand_aliases')) {
          if (values.includes('-s')) state.expandAliases = true;
          if (values.includes('-u')) state.expandAliases = false;
        }
        break;
      }
      case 'set':
        // POSIX mode turns expand_aliases on; leaving it puts back what was there before.
        for (let i = 0; i < args.length && values[i] !== '--' && values[i] !== '-'; i++) {
          const option = values[i] === '-o' || values[i] === '+o' ? args[i + 1] : undefined;
          if (args[i]!.kind === 'dynamic' || option?.kind === 'dynamic') state.expandAliases = state.expandAliases === true ? true : undefined;
          else if (option?.kind === 'static' && option.value === 'posix') state.expandAliases = values[i] === '-o' ? true : state.expandAliases === false ? false : undefined;
          if (option) i++;
        }
        break;
      case 'hash':
        effects.push('shell-state');
        for (let i = 0; i < args.length; i++) {
          if (values[i] === '-r') state.hashed.clear();
          else if (values[i] === '-d') state.hashed.delete(values[++i] ?? '');
          else if (values[i] === '-p') {
            const path = values[i + 1];
            const target = values[i + 2];
            if (target !== undefined) state.hashed.set(target, path);
            else this.finding(ctx, 'loads-code', '`hash -p` gives a command a path only known at run time', call.span);
            i += 2;
          }
        }
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
        if (!args.length) state.cwd = homeOf(state) ?? '~';
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
        const flags = values.filter((value) => value?.startsWith('-')).join('');
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
          if (name === 'export' || flags.includes('x')) state.exported.add(variable);
          const value: Value = flags.includes('n') || match[2] === '+=' || arg.kind === 'dynamic' ? { kind: 'dynamic' } : { kind: 'static', value: text.slice(match[0].length) };
          if (match[2]) this.assigned(variable, value, state, ctx, call, true);
          if (match[2] || value.kind === 'dynamic') state.vars.set(variable, value);
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
      case 'let':
        this.assigns(name, args, state, ctx, call);
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
  }

  /** Builtins that set variables from input (`read`, `mapfile`, `printf -v`, `let`): those become dynamic. */
  assigns(name: string, args: Arg[], state: State, ctx: Context, call: Call): void {
    const values = args.map((arg) => (arg.kind === 'static' ? arg.value : undefined));
    /** Sets a variable by name; `null` for a name only known at run time, which may be any variable. */
    const set = (variable: string | null | undefined) => {
      if (variable === null) return this.finding(ctx, 'sensitive-variable', `${name} sets a variable named only at run time`, call.span);
      if (!variable) return;
      const base = variable.replace(/\[.*$/, '');
      this.assigned(base, { kind: 'dynamic' }, state, ctx, call, true);
      state.vars.set(base, { kind: 'dynamic' });
    };
    const named = (i: number) => (args[i]?.kind === 'dynamic' ? null : values[i]);
    if (name === 'let') {
      for (const value of values) for (const match of (value ?? '').matchAll(/([A-Za-z_]\w*)\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)|([A-Za-z_]\w*)\s*(?:\+\+|--)|(?:\+\+|--)\s*([A-Za-z_]\w*)/g)) set(match[1] ?? match[2] ?? match[3]);
      return;
    }
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
    else if (name === 'read') (positionals.length ? positionals : ['REPLY']).forEach(set);
    else set(positionals[0] === undefined ? 'MAPFILE' : positionals[0]);
  }

  /** A program run from `PATH`, a path, or what `hash -p` gave the name. */
  program(argv: Arg[], state: State, ctx: Context, call: Call): void {
    const name = (argv[0] as Extract<Arg, { kind: 'static' }>).value;
    let path = name.includes('/') ? name : undefined;
    if (!path && state.hashed.has(name)) {
      path = state.hashed.get(name);
      if (path === undefined) this.finding(ctx, 'loads-code', `\`${name}\` was given a path only known at run time`, call.span);
    }
    const program = path ? basename(path) : name;
    const parsed = normalize(argv.slice(1), specFor(program));
    if (path && !isSystemPath(path)) parsed.effects.add('exec:file');
    for (const entry of parsed.env) {
      if (entry.kind !== 'static') continue;
      const equals = entry.value.indexOf('=');
      this.assigned(entry.value.slice(0, equals), { kind: 'static', value: entry.value.slice(equals + 1) }, state, ctx, call, false);
    }
    this.emit(ctx, call, program, 'external', argv, parsed, path);
    if (program === 'git') for (const config of parsed.configs) this.gitConfigEntry(config, state, ctx, call);
    const cwd = parsed.cwd?.kind === 'static' ? resolvePath(call.cwd, parsed.cwd.value, call.home) : parsed.cwd ? undefined : call.cwd;
    const inner: Context = { ...ctx, via: [...ctx.via, program], externalOnly: true };
    const innerCall = (open: boolean): Call => ({ ...call, writes: [], reads: [], command: undefined, noFunctions: true, open: open || call.open, cwd });
    for (const nested of parsed.nested) this.dispatch(nested.argv, clone(state), inner, innerCall(nested.open));
    for (const text of parsed.argvStrings) {
      const words = text.kind === 'static' ? resolveWords(text.value, lookupIn(state)) : undefined;
      if (words) this.dispatch(words, clone(state), inner, innerCall(false));
      else this.finding(ctx, 'dynamic-script', `${program} runs a command line only known at run time`, call.span);
    }
    for (const script of parsed.scripts) {
      if (script.kind === 'dynamic') {
        this.finding(ctx, 'dynamic-script', `${program} runs code only known at run time: ${script.text}`, call.span);
        continue;
      }
      const remote = parsed.effects.has('exec:remote');
      const shell = remote ? freshState(undefined) : childState(state, cwd);
      if (!remote && specFor(program) === specFor('bash')) shell.expandAliases = childAliases(program, parsed, shell);
      this.code(script.value, shell, { ...ctx, via: [...ctx.via, program], externalOnly: false, calls: [] }, call, remote ? `${program} (remote)` : `${program} -c`);
    }
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
    if (risk.script !== undefined) this.code(risk.script, childState(state, state.cwd), { ...ctx, via: [...ctx.via, 'git'], externalOnly: false, calls: [] }, call, `git ${key}`, true);
  }

  /** Code in a string (`bash -c`, `eval`, `trap`, an alias): parsed and walked in `state`. */
  code(text: string, state: State, ctx: Context, call: Call, label: string, open = false): void {
    if (ctx.depth >= this.maxDepth) return this.finding(ctx, 'too-deep', `Code nests deeper than the analysis follows (${label})`, call.span);
    this.script(parse(text), state, { ...ctx, source: text, outer: call.span, nesting: [...ctx.nesting, label], depth: ctx.depth + 1, writes: [], reads: [], open: ctx.open || open });
  }

  /**
   * `variable` set to `value`, in the shell itself (`shell`) or in the environment of what it runs. Some variables
   * change what runs, a finding. Prompt strings and `PROMPT_COMMAND` hold code, which is walked when it's known: they
   * run later, so it's walked in a copy of the state as it is now.
   */
  assigned(variable: string, value: Value, state: State, ctx: Context, call: Call, shell: boolean): void {
    if (shell && variable === 'POSIXLY_CORRECT') state.expandAliases = true;
    const prompt = /^PS[0124]$/.test(variable);
    if ((prompt || variable === 'PROMPT_COMMAND') && value.kind === 'static') {
      if (prompt) this.expansions(value.value, clone(state), ctx, call, variable);
      else this.code(value.value, clone(state), ctx, call, variable);
    } else if (prompt || variable === 'PROMPT_COMMAND' || sensitive.test(variable)) {
      this.finding(ctx, 'sensitive-variable', `Setting ${variable} changes what runs or how`, call.span);
    }
  }

  /** Text expanded like a here-document's body (a prompt string): the substitutions in it run. */
  expansions(text: string, state: State, ctx: Context, call: Call, label: string): void {
    if (ctx.depth >= this.maxDepth) return this.finding(ctx, 'too-deep', `Code nests deeper than the analysis follows (${label})`, call.span);
    let delimiter = 'BASH_GATE_EOF';
    while (text.split('\n').includes(delimiter)) delimiter += '_';
    const source = `: <<${delimiter}\n${text}\n${delimiter}\n`;
    const script = parse(source);
    const inner = { ...ctx, source, outer: call.span, nesting: [...ctx.nesting, label], depth: ctx.depth + 1, writes: [], reads: [] };
    for (const error of script.errors ?? []) this.finding(inner, 'parse-error', `Parse error: ${error.message}`, call.span);
    this.substitutions(script.commands, state, inner);
  }

  emit(ctx: Context, call: Call, program: string | null, kind: Invocation['kind'], argv: Arg[], parsed: Parsed, path?: string): void {
    if (ctx.silent) return;
    const writes = [...parsed.writes, ...call.writes, ...ctx.writes];
    const reads = [...parsed.reads, ...call.reads, ...ctx.reads];
    if (call.writes.length || ctx.writes.length) parsed.effects.add('fs:write');
    if (call.reads.length || ctx.reads.length) parsed.effects.add('fs:read');
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
      via: ctx.via,
      nesting: ctx.nesting,
      shape: '',
      span: call.span,
      text: this.analysis.source.slice(call.span[0], call.span[1]),
    };
    invocation.shape = shape(invocation);
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

function argument(item: Command['suffix'][number], lookup: Lookup): Arg[] {
  if (item.type === 'Word') return resolveWord(item, lookup);
  if (item.type !== 'Assignment') return [];
  const value = assignmentValue(item, lookup);
  const prefix = `${item.name}${item.append ? '+=' : '='}`;
  return [value.kind === 'static' ? { kind: 'static', value: prefix + value.value } : dynamicArg(item.text, 'variable', false, prefix)];
}

function assignmentValue(assignment: Assignment, lookup: Lookup): Value {
  if (assignment.value.type === 'ArrayValue' || assignment.append || assignment.index) return { kind: 'dynamic' };
  return resolveValue(assignment.value as Word, lookup);
}

/** The files redirections read and write, devices left out. A redirection to an fd (`2>&1`) names no file. */
function redirections(list: readonly Redirection[], lookup: Lookup): { reads: Arg[]; writes: Arg[] } {
  const reads: Arg[] = [];
  const writes: Arg[] = [];
  for (const redirection of list) {
    if (redirection.type !== 'Redirect' || !redirection.target) continue;
    const targets = resolveWord(redirection.target, lookup).filter((arg) => arg.kind === 'dynamic' || !devices.test(arg.value));
    const operator = redirection.operator;
    if ((operator === '>&' || operator === '<&') && targets.every((arg) => arg.kind === 'static' && /^(\d+-?|-)$/.test(arg.value))) continue;
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
    sameMap(a.vars, b.vars, (x, y) => (x.kind === 'dynamic' ? y.kind === 'dynamic' : y.kind === 'static' && x.value === y.value)) &&
    sameSet(a.exported, b.exported) &&
    sameMap(a.functions, b.functions, (x, y) => x.maybeUndefined === y.maybeUndefined && sameSet(new Set(x.bodies), new Set(y.bodies))) &&
    sameSet(a.exportedFunctions, b.exportedFunctions) &&
    sameMap(a.aliases, b.aliases, sameAlias) &&
    a.aliasesUnknown === b.aliasesUnknown &&
    a.expandAliases === b.expandAliases &&
    sameMap(a.hashed, b.hashed) &&
    sameSet(a.disabled, b.disabled) &&
    a.cwd === b.cwd
  );
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
    cwd: state.cwd,
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
    cwd,
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
    if (!a || !b || a.kind === 'dynamic' || b.kind === 'dynamic' || a.value !== b.value) state.vars.set(name, { kind: 'dynamic' });
  }
  for (const name of other.exported) state.exported.add(name);
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
  for (const name of new Set([...state.hashed.keys(), ...other.hashed.keys()])) {
    if (state.hashed.get(name) !== other.hashed.get(name)) state.hashed.set(name, undefined);
  }
  for (const name of other.disabled) state.disabled.add(name);
  if (state.cwd !== other.cwd) state.cwd = undefined;
}

/** What `~` stands for: `$HOME` when it's known and absolute. */
function homeOf(state: State): string | undefined {
  const home = state.vars.get('HOME');
  return home?.kind === 'static' && home.value.startsWith('/') ? home.value : undefined;
}
