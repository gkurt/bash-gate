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
  functions: Map<string, { bodies: FunctionNode[]; maybeUndefined: boolean }>;
  exportedFunctions: Set<string>;
  /** Aliases with the line they were defined on (they apply from the next line); `value` is unknown for a dynamic definition. */
  aliases: Map<string, { value: string | undefined; line: number }>;
  aliasesUnknown: boolean;
  /** `shopt -s expand_aliases`: on, off, or `undefined` when it may be either. */
  expandAliases: boolean | undefined;
  /** `hash -p` paths by name; `undefined` for one set dynamically. */
  hashed: Map<string, string | undefined>;
  /** Builtins turned off with `enable -n`: the name runs the program instead. */
  disabled: Set<string>;
  cwd: string | undefined;
}

/** Where the walk is: the source positions index, and how it got there. */
interface Context {
  source: string;
  /** For code parsed from a string, the span of what holds it in the top-level source. */
  outer?: [number, number];
  /** The top-level line this source starts on, for when aliases apply. */
  line: number;
  nesting: string[];
  via: string[];
  depth: number;
  /** Functions being called, so recursion stops. */
  calls: string[];
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
  line: number;
  writes: Arg[];
  reads: Arg[];
  /** The command word is a plain word, which aliases may replace. */
  aliasable: boolean;
  /** `command name`: functions are skipped. */
  noFunctions: boolean;
  open: boolean;
  cwd: string | undefined;
}

const builtins = new Set(
  ': . [ alias bg bind break builtin caller cd command compgen complete compopt continue declare dirs disown echo enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type typeset ulimit umask unalias unset wait'.split(
    ' ',
  ),
);

/** Variables that change what runs or where it's looked up, for the shell or the programs it starts. */
const sensitive =
  /^(PATH|BASH_ENV|ENV|IFS|PS4|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|CDPATH|HOME|ZDOTDIR|TMPDIR|XDG_CONFIG_HOME|LD_[A-Z_]+|DYLD_[A-Z_]+|GIT_[A-Z_]+|PAGER|MANPAGER|EDITOR|VISUAL|LESSOPEN|LESSCLOSE|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|SSH_ASKPASS|SUDO_ASKPASS|npm_config_\w+|NPM_CONFIG_\w+)$/;

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
  const context: Context = { source, line: 0, nesting: [], via: [], depth: 0, calls: [], externalOnly: false, writes: [], reads: [], silent: false, open: false };
  new Walker(analysis, options.maxDepth ?? 12).script(parse(source), state, context);
  return analysis;
}

class Walker {
  analysis: Analysis;
  maxDepth: number;

  constructor(analysis: Analysis, maxDepth: number) {
    this.analysis = analysis;
    this.maxDepth = maxDepth;
  }

  script(script: ParsedScript, state: State, ctx: Context): void {
    for (const error of script.errors ?? []) this.finding(ctx, 'parse-error', `Parse error: ${error.message}`, [error.pos, error.pos]);
    this.list(script.commands, state, ctx);
  }

  list(statements: readonly Statement[], state: State, ctx: Context): void {
    for (const statement of statements) this.node(statement.command, statement.background ? clone(state) : state, ctx);
  }

  node(node: PipelineNode | AndOr | CommandNode | CompoundList, state: State, ctx: Context): void {
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
        state.vars.set(node.name.value, only?.kind === 'static' ? { kind: 'static', value: only.value } : { kind: 'dynamic' });
        return this.loop(state, ctx, (s, c) => this.list(node.body.commands, s, c));
      }
      case 'ArithmeticFor':
        for (const expression of [node.initialize, node.test, node.update]) if (expression) this.arithmetic(expression, state, ctx);
        return this.loop(state, ctx, (s, c) => this.list(node.body.commands, s, c));
      case 'While':
        return this.loop(state, ctx, (s, c) => this.list([...node.clause.commands, ...node.body.commands], s, c));
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
        state.functions.set(node.name.value, { bodies: [node], maybeUndefined: false });
        return;
      case 'Coproc':
        return this.node(node.body, clone(state), ctx);
    }
  }

  /** Runs `walk` on a copy of `state`, for one way through a conditional. */
  branch(state: State, ctx: Context, walk: (state: State, ctx: Context) => void): State {
    const copy = clone(state);
    walk(copy, ctx);
    return copy;
  }

  /**
   * A loop body: walked once silently to see which variables it changes, which then count as dynamic, then once for
   * real. The loop may run any number of times, so what holds after it is joined with what held before.
   */
  loop(state: State, ctx: Context, walk: (state: State, ctx: Context) => void): void {
    join(state, this.branch(state, { ...ctx, silent: true }, walk));
    join(state, this.branch(state, ctx, walk));
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
      if (target?.type === 'ArithmeticWord') state.vars.set(target.value.replace(/\[.*$/, ''), { kind: 'dynamic' });
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
    const line = ctx.line + lineOf(ctx.source, command.pos);
    const argv = command.name ? [...resolveWord(command.name, lookup), ...command.suffix.flatMap((item) => argument(item, lookup))] : [];
    for (const assignment of assignments) {
      const value = assignmentValue(assignment, lookup);
      this.sensitive(ctx, assignment.name, span);
      if (!argv.length) state.vars.set(assignment.name, value);
    }
    const call: Call = {
      span,
      line,
      writes: files.writes,
      reads: files.reads,
      aliasable: !!command.name && !command.name.parts && command.name.text === command.name.value,
      noFunctions: false,
      open: false,
      cwd: state.cwd,
    };
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
    if (call.aliasable && !ctx.externalOnly && state.expandAliases !== false && this.alias(name, argv, state, ctx, call)) return;
    const fn = ctx.externalOnly || call.noFunctions ? undefined : state.functions.get(name);
    if (fn && ctx.calls.includes(name)) return;
    if (fn) {
      this.emit(ctx, call, name, 'function', argv, emptyParsed());
      const bodyCtx = { ...ctx, calls: [...ctx.calls, name] };
      const outcomes = fn.bodies.map((body) => this.branch(state, bodyCtx, (s, c) => this.node(body.body, s, c)));
      settle(state, fn.maybeUndefined ? [...outcomes, clone(state)] : outcomes);
      if (!fn.maybeUndefined) return;
    }
    if (!ctx.externalOnly && builtins.has(name) && !state.disabled.has(name)) return this.builtin(name, argv, state, ctx, call);
    this.program(argv, state, ctx, call);
  }

  /** Expands an alias in place of the command word; `true` when it did (or reported why it couldn't). */
  alias(name: string, argv: Arg[], state: State, ctx: Context, call: Call): boolean {
    const alias = state.aliases.get(name);
    if (!alias || alias.line >= call.line) {
      if (state.aliasesUnknown) this.finding(ctx, 'unknown-alias', `\`${name}\` may be an alias defined at run time`, call.span);
      return false;
    }
    const words = alias.value === undefined ? undefined : resolveWords(alias.value, lookupIn(state));
    if (words?.length) {
      this.dispatch([...words, ...argv.slice(1)], state, ctx, { ...call, aliasable: false });
      return true;
    }
    if (alias.value === undefined) {
      this.finding(ctx, 'unknown-alias', `\`${name}\` is an alias whose value is only known at run time`, call.span);
      return false;
    }
    this.finding(ctx, 'unknown-alias', `\`${name}\` is an alias for more than one command; its arguments aren't followed`, call.span);
    this.code(alias.value, state, ctx, call, `alias ${name}`);
    return true;
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
        if (!lookupOnly && i < args.length) return this.dispatch(args.slice(i), state, ctx, { ...call, aliasable: false, noFunctions: true });
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
        if (i < args.length) return this.dispatch(args.slice(i), state, { ...ctx, externalOnly: true }, { ...call, aliasable: false });
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
            state.aliases.set(arg.value.slice(0, equals), { value: arg.value.slice(equals + 1), line: call.line });
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
        if (!args.length) state.cwd = '~';
        else if (arg?.kind === 'static' && arg.value !== '-') state.cwd = resolvePath(state.cwd, arg.value);
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
          if (match[2]) this.sensitive(ctx, variable, call.span);
          if (flags.includes('n') || match[2] === '+=' || arg.kind === 'dynamic') state.vars.set(variable, { kind: 'dynamic' });
          else if (match[2]) state.vars.set(variable, { kind: 'static', value: text.slice(match[0].length) });
        }
        break;
      }
      case 'unset': {
        const functions = values.includes('-f');
        for (const value of values) {
          if (value === undefined || value.startsWith('-')) continue;
          if (functions) state.functions.delete(value);
          else state.vars.set(value, { kind: 'static', value: '' });
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
    const set = (variable: string | undefined) => variable && state.vars.set(variable.replace(/\[.*$/, ''), { kind: 'dynamic' });
    if (name === 'let') {
      for (const value of values) for (const match of (value ?? '').matchAll(/([A-Za-z_]\w*)\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)|([A-Za-z_]\w*)\s*(?:\+\+|--)|(?:\+\+|--)\s*([A-Za-z_]\w*)/g)) set(match[1] ?? match[2] ?? match[3]);
      return;
    }
    if (name === 'printf') {
      if (values.includes('-v')) set(values[values.indexOf('-v') + 1]);
      return;
    }
    const positionals: (string | undefined)[] = [];
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value?.startsWith('-') && name !== 'getopts') {
        if (/^-[adinNptuCcOs]$/.test(value) && !(name === 'read' && /^-[rs]$/.test(value))) {
          if ((name === 'mapfile' || name === 'readarray') && value === '-C') {
            const code = args[i + 1];
            if (code?.kind === 'static') this.code(code.value, clone(state), ctx, call, `${name} -C`, true);
            else if (code) this.finding(ctx, 'dynamic-script', `${name} -C runs a string only known at run time`, call.span);
          }
          if (name === 'read' && value === '-a') set(values[i + 1]);
          i++;
        }
        continue;
      }
      positionals.push(value);
    }
    if (name === 'getopts') set(positionals[1]);
    else if (name === 'read') positionals.forEach(set);
    else set(positionals[0] ?? 'MAPFILE');
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
      if (entry.kind === 'static') this.sensitive(ctx, entry.value.slice(0, entry.value.indexOf('=')), call.span);
    }
    this.emit(ctx, call, program, 'external', argv, parsed, path);
    if (program === 'git') for (const config of parsed.configs) this.gitConfigEntry(config, state, ctx, call);
    const cwd = parsed.cwd?.kind === 'static' ? resolvePath(call.cwd, parsed.cwd.value) : parsed.cwd ? undefined : call.cwd;
    const inner: Context = { ...ctx, via: [...ctx.via, program], externalOnly: true };
    const innerCall = (open: boolean): Call => ({ ...call, writes: [], reads: [], aliasable: false, noFunctions: true, open: open || call.open, cwd });
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
      this.code(script.value, shell, { ...ctx, via: [...ctx.via, program] }, call, remote ? `${program} (remote)` : `${program} -c`);
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
    if (risk.script !== undefined) this.code(risk.script, childState(state, state.cwd), { ...ctx, via: [...ctx.via, 'git'] }, call, `git ${key}`, true);
  }

  /** Code in a string (`bash -c`, `eval`, `trap`, an alias): parsed and walked in `state`. */
  code(text: string, state: State, ctx: Context, call: Call, label: string, open = false): void {
    if (ctx.depth >= this.maxDepth) return this.finding(ctx, 'too-deep', `Code nests deeper than the analysis follows (${label})`, call.span);
    this.script(parse(text), state, { ...ctx, source: text, outer: call.span, line: call.line, nesting: [...ctx.nesting, label], depth: ctx.depth + 1, writes: [], reads: [], open: ctx.open || open });
  }

  sensitive(ctx: Context, variable: string, span: [number, number]): void {
    if (sensitive.test(variable)) this.finding(ctx, 'sensitive-variable', `Setting ${variable} changes what runs or how`, span);
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

function lineOf(source: string, pos: number): number {
  let line = 0;
  for (let i = source.indexOf('\n'); i !== -1 && i < pos; i = source.indexOf('\n', i + 1)) line++;
  return line;
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
  for (const [name, alias] of other.aliases) {
    const mine = state.aliases.get(name);
    if (!mine) state.aliases.set(name, alias);
    else if (mine.value !== alias.value) state.aliases.set(name, { value: undefined, line: Math.min(mine.line, alias.line) });
  }
  state.aliasesUnknown ||= other.aliasesUnknown;
  if (state.expandAliases !== other.expandAliases) state.expandAliases = undefined;
  for (const name of new Set([...state.hashed.keys(), ...other.hashed.keys()])) {
    if (state.hashed.get(name) !== other.hashed.get(name)) state.hashed.set(name, undefined);
  }
  for (const name of other.disabled) state.disabled.add(name);
  if (state.cwd !== other.cwd) state.cwd = undefined;
}
