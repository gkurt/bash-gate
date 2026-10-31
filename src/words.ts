import { parse, type DoubleQuotedChild, type Word, type WordPart } from 'unbash';
import type { Arg, DynamicReason } from './types.ts';

/** A variable as the analysis knows it: its value, or only that it has one at run time. */
export type Value = { kind: 'static'; value: string } | { kind: 'dynamic'; numeric?: boolean };

/** Looks variables up; `undefined` for one never assigned. */
export type Lookup = (name: string) => Value | undefined;

/** A piece of a word: text, or a value only the run knows. `split` marks unquoted expansions, which field splitting cuts. */
type Segment = { kind: 'text'; value: string; split: boolean } | { kind: 'dynamic'; reason: DynamicReason; split: boolean };

/** One word as brace expansion leaves it. Brace expansion is what makes one word several. */
type Alternative = Segment[];

/** The most words a brace expansion may make before the word counts as dynamic. */
const maxAlternatives = 256;

/** Special parameters and positionals: `$1`, `$@`, `$?`… */
const special = /^(?:[0-9]+|[@*#?$!_-])$/;

/**
 * The arguments a word becomes, in order: brace expansion, then parameter expansion, then field splitting of
 * unquoted expansions. A word with any dynamic part is one dynamic argument; a static word may be none or several.
 */
export function resolveWord(word: Word, lookup: Lookup): Arg[] {
  const alternatives = word.parts
    ? resolveParts(word.parts, lookup, false)
    : [[{ kind: 'text', value: word.value, split: false } as Segment]];
  if (!alternatives) return [dynamicArg(word.text, 'variable', true, '')];
  return alternatives.flatMap((alternative) => toArgs(alternative, word.text));
}

/** The value an assignment stores: no brace expansion, globbing or splitting. */
export function resolveValue(word: Word, lookup: Lookup): Value {
  if (!word.parts) return { kind: 'static', value: word.value };
  if (word.parts.length === 1 && word.parts[0]?.type === 'ArithmeticExpansion') return { kind: 'dynamic', numeric: true };
  let value = '';
  for (const part of word.parts) {
    if (part.type === 'Glob' || part.type === 'BraceExpansion' || part.type === 'ExtendedGlob') {
      value += part.text;
      continue;
    }
    const alternatives = resolveParts([part], lookup, false);
    const only = alternatives?.length === 1 ? alternatives[0] : undefined;
    if (!only) return { kind: 'dynamic' };
    for (const segment of only) {
      if (segment.kind === 'dynamic') return { kind: 'dynamic' };
      value += segment.value;
    }
  }
  return { kind: 'static', value };
}

/** The arguments a string of shell words becomes (`env -S`'s value), or `undefined` when it isn't plain words. */
export function resolveWords(text: string, lookup: Lookup): Arg[] | undefined {
  const script = parse(`: ${text}`);
  const command = script.commands[0]?.command;
  if ((script.errors?.length ?? 0) > 0 || script.commands.length !== 1 || command?.type !== 'Command' || command.redirects.length > 0)
    return undefined;
  return command.suffix.flatMap((item) => {
    if (item.type === 'Word') return resolveWord(item, lookup);
    return item.type === 'Assignment' ? [dynamicArg(item.text, 'variable', false, '')] : [];
  });
}

/** Arguments joined by spaces, as `eval` joins them; `undefined` when any is dynamic. */
export function joinStatic(args: Arg[]): string | undefined {
  const values: string[] = [];
  for (const arg of args) {
    if (arg.kind === 'dynamic') return undefined;
    values.push(arg.value);
  }
  return values.join(' ');
}

export function dynamicArg(text: string, reason: DynamicReason, split: boolean, prefix: string): Arg {
  return { kind: 'dynamic', text, reason, split, prefix };
}

function resolveParts(parts: readonly WordPart[], lookup: Lookup, quoted: boolean): Alternative[] | undefined {
  let alternatives: Alternative[] = [[]];
  for (const part of parts) {
    const next = resolvePart(part, lookup, quoted);
    if (!next) return undefined;
    if (next.length === 1) {
      for (const alternative of alternatives) alternative.push(...next[0]!);
      continue;
    }
    if (alternatives.length * next.length > maxAlternatives) return undefined;
    alternatives = alternatives.flatMap((alternative) => next.map((tail) => [...alternative, ...tail]));
  }
  return alternatives;
}

function resolvePart(part: WordPart | DoubleQuotedChild, lookup: Lookup, quoted: boolean): Alternative[] | undefined {
  switch (part.type) {
    case 'Literal':
    case 'SingleQuoted':
    case 'AnsiCQuoted':
      return [[{ kind: 'text', value: part.value, split: false }]];
    case 'DoubleQuoted':
    case 'LocaleString': {
      const segments: Segment[] = [{ kind: 'text', value: '', split: false }];
      for (const child of part.parts) {
        const resolved = resolvePart(child, lookup, true);
        if (resolved?.length !== 1) return undefined;
        segments.push(...resolved[0]!);
      }
      return [segments];
    }
    case 'SimpleExpansion':
      return [[expand(part.text.slice(1), lookup, quoted)]];
    case 'ParameterExpansion': {
      // `"$@"` and `"${a[@]}"` are as many words as there are elements, quoted or not.
      const many = part.parameter === '@' || part.index?.value === '@';
      if (part.prefix || part.index || part.operation) return [[{ kind: 'dynamic', reason: 'variable', split: !quoted || many }]];
      return [[expand(part.parameter, lookup, quoted)]];
    }
    case 'CommandExpansion':
    case 'ProcessSubstitution':
      return [[{ kind: 'dynamic', reason: 'substitution', split: !quoted }]];
    case 'ArithmeticExpansion':
      return [[{ kind: 'dynamic', reason: 'arithmetic', split: !quoted }]];
    case 'Glob':
    case 'ExtendedGlob':
      return [[{ kind: 'dynamic', reason: 'glob', split: true }]];
    case 'BraceExpansion':
      return expandBraces(part.text, lookup);
    default:
      // A part this version doesn't know (a newer parser): its value can't be known. Substitutions inside it are
      // still found, by the generic walk in the analysis.
      part satisfies never;
      return [[{ kind: 'dynamic', reason: 'substitution', split: true }]];
  }
}

function expand(name: string, lookup: Lookup, quoted: boolean): Segment {
  const value = special.test(name) ? undefined : lookup(name);
  if (value?.kind === 'static') return { kind: 'text', value: value.value, split: !quoted };
  return { kind: 'dynamic', reason: special.test(name) ? 'positional' : 'variable', split: !quoted || name === '@' };
}

/**
 * `{a,b}` and `{1..3}` as Bash expands them. Each alternative is parsed as a word of its own, so quotes, nested braces
 * and expansions inside it resolve as they would anywhere. A brace with one alternative and no sequence stays as text.
 */
function expandBraces(text: string, lookup: Lookup): Alternative[] | undefined {
  const inner = text.slice(1, -1);
  const items = splitTopLevel(inner);
  if (items.length < 2) {
    const sequence = expandSequence(inner);
    if (!sequence) return [[{ kind: 'text', value: text, split: false }]];
    return sequence.map((value) => [{ kind: 'text', value, split: false }]);
  }
  const result: Alternative[] = [];
  for (const item of items) {
    if (item === '') {
      result.push([]);
      continue;
    }
    const word = parseWord(item);
    if (!word) return undefined;
    const alternatives = word.parts
      ? resolveParts(word.parts, lookup, false)
      : [[{ kind: 'text', value: word.value, split: false } as Segment]];
    if (!alternatives) return undefined;
    result.push(...alternatives);
    if (result.length > maxAlternatives) return undefined;
  }
  return result;
}

function parseWord(text: string): Word | undefined {
  const script = parse(`: ${text}`);
  const command = script.commands[0]?.command;
  if ((script.errors?.length ?? 0) > 0 || script.commands.length !== 1 || command?.type !== 'Command' || command.suffix.length !== 1)
    return undefined;
  const word = command.suffix[0];
  return word?.type === 'Word' ? word : undefined;
}

/** Splits a brace body at the commas outside nested braces, quotes and escapes. */
function splitTopLevel(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
    } else if (c === ',' && depth === 0) {
      items.push(text.slice(start, i));
      start = i + 1;
    }
  }
  items.push(text.slice(start));
  return items;
}

/** `1..3`, `a..e`, `10..1..3`: the values of a sequence expression, or `undefined` when it isn't one. */
function expandSequence(text: string): string[] | undefined {
  const numeric = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(text);
  const letters = /^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/.exec(text);
  const match = numeric ?? letters;
  if (!match) return undefined;
  const from = numeric ? Number(match[1]) : match[1]!.charCodeAt(0);
  const to = numeric ? Number(match[2]) : match[2]!.charCodeAt(0);
  const size = Math.abs(Number(match[3] ?? 1));
  const step = size > 0 ? size : 1;
  if (Math.abs(to - from) / step >= maxAlternatives) return undefined;
  const values: string[] = [];
  for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? step : -step)
    values.push(numeric ? String(n) : String.fromCharCode(n));

  return values;
}

/** Field splitting on default `IFS`: unquoted expansions split, quoted text joins its neighbours. */
function toArgs(alternative: Alternative, text: string): Arg[] {
  const dynamic = alternative.filter((segment) => segment.kind === 'dynamic');
  if (dynamic.length > 0) {
    let prefix = '';
    for (const segment of alternative) {
      if (segment.kind === 'dynamic' || segment.split) break;
      prefix += segment.value;
    }
    const reason = dynamic.find((segment) => segment.reason !== 'variable')?.reason ?? dynamic[0]!.reason;
    return [
      dynamicArg(
        text,
        reason,
        dynamic.some((segment) => segment.split),
        prefix,
      ),
    ];
  }
  const fields: string[] = [];
  let current = '';
  let started = false;
  for (const segment of alternative as Extract<Segment, { kind: 'text' }>[]) {
    if (!segment.split) {
      current += segment.value;
      started = true;
      continue;
    }
    segment.value.split(/[ \t\n]+/).forEach((piece, i) => {
      if (i > 0 && (started || current)) {
        fields.push(current);
        current = '';
        started = false;
      }
      current += piece;
      if (piece) started = true;
    });
  }
  if (started || current) fields.push(current);
  return fields.map((value) => ({ kind: 'static', value }));
}
