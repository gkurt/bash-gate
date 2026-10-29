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
  /** Long options may be abbreviated to a unique prefix, as `getopt_long` and git allow. */
  abbreviations?: boolean;
  /** What the positionals are, when they're paths. */
  positionals?: 'read' | 'write' | 'delete';
  /**
   * A command line to run starts after `skip` positionals (`timeout 5 cmd …`). `assignments` takes `NAME=value` words
   * before it as environment (`env`); `open` says arguments are appended at run time (`xargs`); `fallback` is the
   * command when none is given.
   */
  command?: { skip?: number; assignments?: boolean; open?: boolean; fallback?: string };
  effects?: Effect[];
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
  /** Command lines it runs. */
  nested: { argv: Arg[]; open: boolean }[];
  /** Shell code it runs (`bash -c`, `trap`, `git rebase -x`). */
  scripts: Arg[];
  /** Strings of shell words it runs as a command line (`env -S`). */
  argvStrings: Arg[];
  /** `NAME=value` it sets in the environment of what it runs. */
  env: Arg[];
  /** Configuration entries (`git -c key=value`). */
  configs: Arg[];
  /** A working directory it switches to (`git -C`, `env -C`). */
  cwd?: Arg;
}

const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;

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
    const optionsOpen = !ended && !(current?.posix && seen > 0);
    if (arg.kind === 'static' && optionsOpen) {
      if (arg.value === '--') {
        ended = true;
        continue;
      }
      if (isOption(arg.value)) {
        i = readOption(args, i, current, parsed);
        continue;
      }
    }
    if (arg.kind === 'dynamic' && optionsOpen && mayBeOption(arg)) parsed.maybeOptions = true;
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
      if (command.assignments && arg.kind === 'static' && assignment.test(arg.value)) {
        parsed.env.push(arg);
        continue;
      }
      if (seen >= (command.skip ?? 0)) {
        parsed.nested.push({ argv: args.slice(i), open: !!command.open });
        break;
      }
    }
    parsed.positionals.push(arg);
    seen++;
    if (current?.positionals === 'read') parsed.reads.push(arg);
    if (current?.positionals === 'write' || current?.positionals === 'delete') parsed.writes.push(arg);
  }
  if (current?.command?.fallback && !parsed.nested.length) {
    parsed.nested.push({ argv: [{ kind: 'static', value: current.command.fallback }], open: !!current.command.open });
  }
  for (const level of levels) level.finish?.(parsed);
  return parsed;
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

/** A dynamic word that may begin an option: one with no static start, or one that starts with `-`. */
function mayBeOption(arg: Extract<Arg, { kind: 'dynamic' }>): boolean {
  return arg.prefix === '' || arg.prefix.startsWith('-');
}

function readOption(args: Arg[], i: number, spec: CommandSpec | undefined, parsed: Parsed): number {
  const value = (args[i] as Extract<Arg, { kind: 'static' }>).value;
  if (value.startsWith('--')) {
    const equals = value.indexOf('=');
    const name = equals < 0 ? value : value.slice(0, equals);
    const attached = equals < 0 ? undefined : value.slice(equals + 1);
    const option = findLong(spec, name);
    if (!option) {
      unknown(parsed, name, attached === undefined ? true : { kind: 'static', value: attached });
      return i;
    }
    const takes = option.value && (!option.valued || option.valued.some((spelling) => spelling.startsWith('--')));
    let optionValue: Arg | true = true;
    if (takes && attached !== undefined) optionValue = { kind: 'static', value: attached };
    else if (takes && option.value === true && i + 1 < args.length) optionValue = args[++i]!;
    record(parsed, option, optionValue);
    return i;
  }
  for (let j = 1; j < value.length; j++) {
    const name = `-${value[j]}`;
    const option = findOption(spec, name);
    if (!option) {
      unknown(parsed, name, true);
      continue;
    }
    if (!option.value || (option.valued && !option.valued.includes(name))) {
      record(parsed, option, true);
      continue;
    }
    const rest = value.slice(j + 1);
    let optionValue: Arg | true = true;
    if (rest) optionValue = { kind: 'static', value: rest };
    else if (option.value === true && i + 1 < args.length) optionValue = args[++i]!;
    record(parsed, option, optionValue);
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
  if (option.role === 'cwd') parsed.cwd = value;
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
