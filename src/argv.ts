import type { Arg, Effect } from './types.ts';

export interface OptionSpec {
  /** The canonical name first: `['--force', '-f']`. */
  names: string[];
  /** Takes a value: in the same word or the next (`true`), or only in the same word (`'attached'`: `--color[=WHEN]`). */
  value?: boolean | 'attached';
  /** The spellings that take the value, when not all do: `-f` is a flag where `--follow[=how]` takes one. */
  valued?: string[];
  /** What the value is, when it's more than data: shell code, a command line, a path, a working directory, a config entry. */
  role?: 'script' | 'argv' | 'read' | 'write' | 'cwd' | 'config';
  effects?: Effect[];
}

export interface CommandSpec {
  options?: OptionSpec[];
  /** Subcommands by name, aliases after `|`: `'rm|remove'`. */
  subcommands?: Record<string, CommandSpec>;
  /** Options end at the first positional, as POSIX has it (`sudo`, `env`, `xargs`), rather than anywhere, as GNU has it. */
  posix?: boolean;
  /** Every word after it is an argument, none an option: what `pnpm test --watch` passes to the script. */
  verbatim?: boolean;
  /** Options may start with `+` too, which turns them off (a shell's `+x`, `+O name`): they're read as `+x`. */
  plus?: boolean;
  /** A flag takes a `true` or `false` after it as its value, as nopt reads argv (npm, pnpm): `--color false exec`. */
  nopt?: boolean;
  /**
   * An option's value is never a separate word that starts with `-`: that word is read as an option, and the option
   * goes without (mri and cac, minimist, yargs, and nopt for strings: vite, prettier, pnpm `-C --x`).
   */
  dashless?: boolean;
  /** Long options may be abbreviated to a unique prefix, as `getopt_long` and git allow. */
  abbreviations?: boolean;
  /** Read as Go's pflag reads it (cobra): `-o=value` is `-o` with `value`, a flag's too (`-f=false`). */
  cobra?: boolean;
  /** What the positionals are, when they're paths. */
  positionals?: 'read' | 'write' | 'delete';
  /**
   * A command line to run starts after `skip` positionals (`timeout 5 cmd …`). `assignments` takes `NAME=value` words
   * before it as environment (`sudo`), or with `'any'` every word with an `=` (`env`, which sets `--x=1` too); `open`
   * says arguments are appended at run time (`xargs`); `fallback` is the command when none is given.
   */
  command?: { skip?: number; assignments?: boolean | 'any'; open?: boolean; fallback?: string };
  effects?: Effect[];
  /**
   * The only files it writes without naming them, by name: what a compiler emits, what a formatter rewrites. Without it,
   * a program that writes without saying where may write anything.
   */
  edits?: RegExp;
  /** For programs whose arguments aren't options and positionals (`find`): parses them in place of the generic parser. */
  parse?: (args: Arg[], parsed: Parsed) => void;
  /** Whatever options and positionals can't say, once they're parsed: `bash -c`'s script is its first positional. */
  finish?: (parsed: Parsed) => void;
}

/** A command line read with its program's spec. */
export interface Parsed {
  subcommands: string[];
  unknownSubcommand?: Arg;
  options: Record<string, (Arg | true)[]>;
  unknownOptions: string[];
  positionals: Arg[];
  maybeOptions: boolean;
  effects: Set<Effect>;
  reads: Arg[];
  writes: Arg[];
  /**
   * Files and directories whose code it runs, or whose configuration it loads, as the project's: another's where
   * they're outside the project (`bun test /tmp/x.test.ts`, `eslint ../other`).
   */
  loads?: Arg[];
  /** Of `writes`, where a program with `edits` rewrites only files of that kind: the files and directories it is given. */
  edited?: Arg[];
  /** Command lines it runs. */
  nested: { argv: Arg[]; open: boolean }[];
  /** Shell code it runs (`bash -c`, `trap`, `git rebase -x`). */
  scripts: Arg[];
  /** Whether it runs its standard input as shell code (`bash`, `sh -s`). */
  stdinScript?: boolean;
  /** Strings of shell words it runs as a command line (`env -S`). */
  argvStrings: Arg[];
  /** `NAME=value` it sets in the environment of what it runs. */
  env: Arg[];
  /** Configuration entries (`git -c key=value`). */
  configs: Arg[];
  /** Whether `--` ended the options: what follows is no option, and for git, no revision. */
  separated?: boolean;
  /** A working directory it switches to (`git -C`, `env -C`). */
  cwd?: Arg;
}

export const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words only known at run time, standing for a command line whose start isn't known. */
export const anyWords: Arg = { kind: 'dynamic', text: '…', reason: 'placeholder', split: true, prefix: '' };

export function emptyParsed(effects: Effect[] = []): Parsed {
  return {
    subcommands: [],
    options: {},
    unknownOptions: [],
    positionals: [],
    maybeOptions: false,
    effects: new Set(effects),
    reads: [],
    writes: [],
    nested: [],
    scripts: [],
    argvStrings: [],
    env: [],
    configs: [],
  };
}

/** Reads `args` (the program left out) with `spec`, or by GNU conventions when there's none. */
export function normalize(args: Arg[], spec: CommandSpec | undefined): Parsed {
  const parsed = emptyParsed(spec?.effects);
  if (spec?.parse) {
    spec.parse(args, parsed);
    return parsed;
  }
  const levels: CommandSpec[] = spec ? [spec] : [];
  let current = spec;
  let subcommandsOpen = !!spec?.subcommands;
  let ended = false;
  let seen = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const optionsOpen = !ended && !current?.verbatim && !(current?.posix && seen > 0);
    if (arg.kind === 'static' && optionsOpen) {
      if (arg.value === '--') {
        ended = true;
        parsed.separated = true;
        continue;
      }
      if (isOption(arg.value)) {
        const last = readOption(args, i, current, parsed, !!spec?.nopt, !!spec?.dashless);
        // A value that may be no word or several (`nice -n $x cat`) leaves where the command starts unknown.
        if (current?.command && last > i && mayBeSeveral(args[last]!)) {
          parsed.nested.push({ argv: [anyWords, ...args.slice(last + 1)], open: !!current.command.open });
          break;
        }
        i = last;
        continue;
      }
      if (current?.plus && arg.value.length > 1 && arg.value.startsWith('+')) {
        i = readPlus(args, i, current, parsed);
        continue;
      }
    }
    if (arg.kind === 'dynamic' && optionsOpen && (mayBeOption(arg) || (current?.plus && arg.prefix.startsWith('+'))))
      parsed.maybeOptions = true;
    if (subcommandsOpen && current?.subcommands) {
      const found = arg.kind === 'static' ? findSubcommand(current.subcommands, arg.value) : undefined;
      if (found) {
        parsed.subcommands.push(found[0]);
        current = found[1];
        levels.push(current);
        for (const effect of current.effects ?? []) parsed.effects.add(effect);
        subcommandsOpen = !!current.subcommands;
        seen = 0;
        continue;
      }
      parsed.unknownSubcommand = arg;
      subcommandsOpen = false;
    }
    const command = current?.command;
    if (command) {
      // A word only known at run time is an assignment by its start (`PATH="$PATH"`), unless it may split, or be an
      // option (`--split-string="$x"`).
      const start = arg.kind === 'static' ? arg.value : arg.prefix;
      const equals = start.includes('=');
      const whole = arg.kind === 'static' || (!arg.split && !(optionsOpen && start.startsWith('-')));
      const assigns = command.assignments === 'any' || (command.assignments === true && assignment.test(start));
      if (equals && whole && assigns) {
        parsed.env.push(arg);
        continue;
      }
      // Before the command (`timeout $x cat`), a word that may be several holds its start, and one that may be an
      // option moves it.
      const unplaced = seen < (command.skip ?? 0) && arg.kind === 'dynamic' && (mayBeSeveral(arg) || (optionsOpen && mayBeOption(arg)));
      if (unplaced) {
        parsed.nested.push({ argv: [anyWords, ...args.slice(i + 1)], open: !!command.open });
        break;
      }
      if (seen >= (command.skip ?? 0)) {
        // An option the spec doesn't know may have taken the next word as its value, and a word with an `=` that's no
        // name may be taken as an assignment: the command may start anywhere.
        const unsure = parsed.unknownOptions.length > 0 || (command.assignments !== undefined && command.assignments !== false && equals);
        parsed.nested.push({ argv: unsure ? [anyWords, ...args.slice(i)] : args.slice(i), open: !!command.open });
        break;
      }
    }
    parsed.positionals.push(arg);
    seen++;
    if (current?.positionals === 'read') parsed.reads.push(arg);
    if (current?.positionals === 'write' || current?.positionals === 'delete') parsed.writes.push(arg);
  }
  if (current?.command?.fallback && parsed.nested.length === 0)
    parsed.nested.push({ argv: [{ kind: 'static', value: current.command.fallback }], open: !!current.command.open });

  for (const level of levels) level.finish?.(parsed);
  return parsed;
}

/**
 * Reads `args` as a cobra (Go) program does, for a spec's `parse`. The subcommand is the first word that isn't a flag,
 * and a flag before it takes the next word unless it's a known boolean or has its value after `=`: `gh -R o/r pr merge`
 * runs `pr merge`, with `-R` its option. The leaf then reads its options anywhere: a level's options must be copied to
 * the levels under it, as cobra's persistent flags are.
 */
export function readCobra(root: CommandSpec, args: Arg[], parsed: Parsed): void {
  const levels = [root];
  let current = root;
  let rest = args;
  search: while (current.subcommands) {
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg.kind === 'dynamic') {
        if (!arg.split && arg.prefix.startsWith('-') && arg.prefix.includes('=')) continue;
        parsed.unknownSubcommand = arg;
        break search;
      }
      if (arg.value === '--') break search;
      if (arg.value === '') continue;
      if (arg.value.startsWith('-')) {
        if (cobraTakesNext(current, arg.value)) i++;
        continue;
      }
      const found = findSubcommand(current.subcommands, arg.value);
      if (!found) {
        parsed.unknownSubcommand = arg;
        break search;
      }
      parsed.subcommands.push(found[0]);
      current = found[1];
      levels.push(current);
      rest = [...rest.slice(0, i), ...rest.slice(i + 1)];
      continue search;
    }
    break;
  }
  const leaf = normalize(rest, { ...current, cobra: true, subcommands: undefined, parse: undefined, finish: undefined });
  for (const level of levels) for (const effect of level.effects ?? []) leaf.effects.add(effect);
  Object.assign(parsed, leaf, { subcommands: parsed.subcommands });
  for (const level of levels) level.finish?.(parsed);
}

/** Whether cobra, looking for a subcommand, skips the word after this flag as its value. */
function cobraTakesNext(spec: CommandSpec, flag: string): boolean {
  if (flag.includes('=') || (!flag.startsWith('--') && flag.length !== 2)) return false;
  const option = findOption(spec, flag);
  return !option || (option.value === true && (!option.valued || option.valued.includes(flag)));
}

/** The spec at `subcommands` below `spec`, for reading option names in a policy with the right level's spellings. */
export function specAt(spec: CommandSpec | undefined, subcommands: string[]): CommandSpec | undefined {
  let current = spec;
  for (const name of subcommands) current = current?.subcommands && findSubcommand(current.subcommands, name)?.[1];
  return current;
}

/** The canonical name of an option as `spec` spells it, or the name itself when the spec doesn't know it. */
export function canonicalOption(spec: CommandSpec | undefined, name: string): string {
  const option = name.startsWith('--') ? findLong(spec, name) : findOption(spec, name);
  return option?.names[0] ?? name;
}

export function isOption(value: string): boolean {
  return value.length > 1 && value.startsWith('-');
}

/**
 * A dynamic word that may begin an option: one with no static start, one that starts with `-`, or one that may split,
 * whose later words may be options whatever its start (`HEAD$x` with `x=' --output=f'`).
 */
function mayBeOption(arg: Extract<Arg, { kind: 'dynamic' }>): boolean {
  return arg.prefix === '' || arg.prefix.startsWith('-') || arg.split;
}

/** A word only known at run time that may be no word at all, or several. */
function mayBeSeveral(arg: Arg): boolean {
  return arg.kind === 'dynamic' && arg.split;
}

function readOption(args: Arg[], i: number, spec: CommandSpec | undefined, parsed: Parsed, nopt = false, dashless = false): number {
  // nopt reads the word after a flag as its value when it's `true` or `false`; one only known at run time may be.
  const boolean = (at: number): Arg | true => {
    const next = args[at];
    if (!nopt || !next) return true;
    if (next.kind === 'dynamic') {
      parsed.maybeOptions = true;
      return true;
    }
    return next.value === 'true' || next.value === 'false' ? next : true;
  };
  // Whether the next word is the option's value. Where values never start with `-`, one only known at run time may
  // not be, and then it's read as options.
  const takesNext = (at: number): boolean => {
    const next = args[at];
    if (!next) return false;
    if (!dashless) return true;
    if (next.kind === 'static') return !(next.value.length > 1 && next.value.startsWith('-'));
    if (next.prefix === '' || next.prefix.startsWith('-')) parsed.maybeOptions = true;
    return true;
  };
  const value = (args[i] as Extract<Arg, { kind: 'static' }>).value;
  if (value.startsWith('--')) {
    const equals = value.indexOf('=');
    const name = equals < 0 ? value : value.slice(0, equals);
    const attached = equals < 0 ? undefined : value.slice(equals + 1);
    const option = findLong(spec, name);
    if (!option) {
      const given = attached === undefined ? boolean(i + 1) : { kind: 'static' as const, value: attached };
      unknown(parsed, name, given);
      return attached === undefined && given !== true ? i + 1 : i;
    }
    const takes = (option.value ?? false) !== false && (!option.valued || option.valued.some((spelling) => spelling.startsWith('--')));
    // A flag given a value keeps it: npm reads `--ignore-scripts=false` as false. Only `true` means it's simply on.
    let optionValue: Arg | true = true;
    if (attached !== undefined) optionValue = { kind: 'static', value: attached };
    else if (takes && option.value === true && takesNext(i + 1)) optionValue = args[++i]!;
    else if (!takes && (optionValue = boolean(i + 1)) !== true) i++;
    record(parsed, option, optionValue);
    if (optionValue === args[i] && mayBeSeveral(optionValue)) parsed.maybeOptions = true;
    return i;
  }
  for (let j = 1; j < value.length; j++) {
    const name = `-${value[j]}`;
    const option = findOption(spec, name);
    if (!option) {
      unknown(parsed, name, true);
      continue;
    }
    if (spec?.cobra && value[j + 1] === '=') {
      record(parsed, option, { kind: 'static', value: value.slice(j + 2) });
      break;
    }
    if ((option.value ?? false) === false || (option.valued && !option.valued.includes(name))) {
      const given = j === value.length - 1 ? boolean(i + 1) : true;
      if (given !== true) i++;
      record(parsed, option, given);
      continue;
    }
    const rest = value.slice(j + 1);
    let optionValue: Arg | true = true;
    if (rest) optionValue = { kind: 'static', value: rest };
    else if (option.value === true && takesNext(i + 1)) optionValue = args[++i]!;
    record(parsed, option, optionValue);
    // A value that may split leaves words after it, which may be options (`-n a$x` with `x=' -f'`).
    if (optionValue === args[i] && mayBeSeveral(optionValue)) parsed.maybeOptions = true;
    break;
  }
  return i;
}

/** `+abc`, which turns options off: each letter is recorded as `+a`, with the value of one that takes it. */
function readPlus(args: Arg[], i: number, spec: CommandSpec, parsed: Parsed): number {
  const value = (args[i] as Extract<Arg, { kind: 'static' }>).value;
  for (let j = 1; j < value.length; j++) {
    const name = `+${value[j]}`;
    const option = findOption(spec, `-${value[j]}`);
    if (!option) {
      unknown(parsed, name, true);
      continue;
    }
    if (option.value !== true) {
      (parsed.options[name] ??= []).push(true);
      continue;
    }
    const rest = value.slice(j + 1);
    (parsed.options[name] ??= []).push(rest ? { kind: 'static', value: rest } : i + 1 < args.length ? args[++i]! : true);
    break;
  }
  return i;
}

function record(parsed: Parsed, option: OptionSpec, value: Arg | true): void {
  const name = option.names[0]!;
  (parsed.options[name] ??= []).push(value);
  for (const effect of option.effects ?? []) parsed.effects.add(effect);
  if (value === true) return;
  if (option.role === 'script') parsed.scripts.push(value);
  if (option.role === 'argv') parsed.argvStrings.push(value);
  if (option.role === 'read') parsed.reads.push(value);
  if (option.role === 'write') parsed.writes.push(value);
  if (option.role === 'config') parsed.configs.push(value);
  if (option.role === 'cwd') {
    // A relative one after another is from there for git and make (`git -C /tmp -C x`), from the start for others.
    const after = parsed.cwd !== undefined && !(value.kind === 'static' && value.value.startsWith('/'));
    parsed.cwd = after
      ? { kind: 'dynamic', text: value.kind === 'static' ? value.value : value.text, reason: 'placeholder', split: false, prefix: '' }
      : value;
  }
}

/** Whether a flag that turns something off is on: given last, and without a value (`--offline=false`). */
export function flag(parsed: Parsed, name: string): boolean {
  return parsed.options[name]?.at(-1) === true;
}

function unknown(parsed: Parsed, name: string, value: Arg | true): void {
  parsed.unknownOptions.push(name);
  (parsed.options[name] ??= []).push(value);
}

function findOption(spec: CommandSpec | undefined, name: string): OptionSpec | undefined {
  return spec?.options?.find((option) => option.names.includes(name));
}

/** A long option by its name, or by a prefix of exactly one name when the spec allows abbreviations. */
function findLong(spec: CommandSpec | undefined, name: string): OptionSpec | undefined {
  const exact = findOption(spec, name);
  if (exact || !spec?.abbreviations || name.length < 3) return exact;
  const matches = (spec.options ?? []).filter((option) => option.names.some((n) => n.startsWith('--') && n.startsWith(name)));
  return matches.length === 1 ? matches[0] : undefined;
}

function findSubcommand(subcommands: Record<string, CommandSpec>, name: string): [string, CommandSpec] | undefined {
  for (const [key, spec] of Object.entries(subcommands)) {
    const names = key.split('|');
    if (names.includes(name)) return [names[0]!, spec];
  }
  return undefined;
}
