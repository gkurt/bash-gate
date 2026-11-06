import { parse, type AnsiCQuotedPart, type DoubleQuotedChild, type Word, type WordPart } from 'unbash';
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
  if (bracesDisagree(word)) return [dynamicArg(word.text, 'variable', true, '')];
  const texts = word.parts && braceTexts(word.text, word.parts);
  if (texts) {
    if (texts.length === 0 || texts.length > maxAlternatives) return [dynamicArg(word.text, 'variable', true, '')];
    const args: Arg[] = [];
    for (const text of texts) {
      if (text === '') continue;
      const next = parseWord(text);
      if (!next) return [dynamicArg(word.text, 'variable', true, '')];
      args.push(...resolveWord(next, lookup));
      if (args.length > maxAlternatives) return [dynamicArg(word.text, 'variable', true, '')];
    }
    return args;
  }
  const alternatives = word.parts
    ? resolveParts(word.parts, lookup, false)
    : [[{ kind: 'text', value: word.value, split: false } as Segment]];
  if (!alternatives) return [dynamicArg(word.text, 'variable', true, '')];
  return alternatives.flatMap((alternative) => toArgs(alternative, word.text, whole(word.parts ?? [])));
}

/**
 * Whether Bash keeps a word from splitting: a `$` that starts no expansion does, unless an unquoted expansion comes after
 * it. `$x-$` and `$x$/"$x"` are one word whatever `$x` holds; `$x$/$x` splits.
 */
function whole(parts: readonly WordPart[]): boolean {
  const last = parts.findLastIndex((part) => part.type === 'Literal' && part.text.replaceAll(/\\[\s\S]/g, '').includes('$'));
  const expansions = new Set(['SimpleExpansion', 'ParameterExpansion', 'CommandExpansion', 'ArithmeticExpansion']);
  return last !== -1 && !parts.slice(last + 1).some((part) => expansions.has(part.type));
}

/** The value an assignment stores: no brace expansion, globbing or splitting. */
export function resolveValue(word: Word, lookup: Lookup): Value {
  if (!word.parts) return { kind: 'static', value: word.value };
  if (word.parts.length === 1 && word.parts[0]?.type === 'ArithmeticExpansion') return { kind: 'dynamic', numeric: true };
  const value = valueText(word.parts, lookup);
  return value === undefined ? { kind: 'dynamic' } : { kind: 'static', value };
}

/**
 * What parts stand for with no brace expansion, globbing or splitting, or `undefined` when the run decides. Quotes
 * inside a glob or braces are still removed: `x=a['q']` stores `a[q]`.
 */
function valueText(parts: readonly WordPart[], lookup: Lookup): string | undefined {
  let value = '';
  for (const part of parts) {
    if (part.type === 'Glob' || part.type === 'ExtendedGlob') {
      const open = part.type === 'Glob' ? 1 : 2;
      if (!part.parts) {
        value += part.text;
      } else {
        if (part.parts.map((child) => child.text).join('') !== part.text.slice(open, -1)) return undefined;
        const inner = valueText(part.parts, lookup);
        if (inner === undefined) return undefined;
        value += part.text.slice(0, open) + inner + part.text.slice(-1);
      }
      continue;
    }
    if (part.type === 'BraceExpansion') {
      if (/['"\\$`]/.test(part.text)) return undefined;
      value += part.text;
      continue;
    }
    const alternatives = resolveParts([part], lookup, false);
    const only = alternatives?.length === 1 ? alternatives[0] : undefined;
    if (!only) return undefined;
    for (const segment of only) {
      if (segment.kind === 'dynamic') return undefined;
      value += segment.value;
    }
  }
  return value;
}

/**
 * What `text` stands for as one word expanded with no splitting or globbing, as an assignment's value is: `undefined`
 * when the run decides, `null` when it isn't one word.
 */
export function expandText(text: string, lookup: Lookup): string | undefined | null {
  const word = parseWord(text);
  if (!word) return null;
  const value = resolveValue(word, lookup);
  return value.kind === 'static' ? value.value : undefined;
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

/**
 * `text` with each `$'…'` in it replaced by what it stands for, as Bash reads arithmetic before expanding it again:
 * `$(( $'\x24(ls)' ))` runs `ls`. One that can't be read is left as it is.
 */
export function decodeAnsiC(text: string): string {
  return text.replaceAll(/\$'(?:\\[\s\S]|[^'\\])*'/g, (quoted) => {
    const [part] = parseWord(quoted)?.parts ?? [];
    return part?.type === 'AnsiCQuoted' ? ansiC(part) : quoted;
  });
}

export function dynamicArg(text: string, reason: DynamicReason, split: boolean, prefix: string): Arg {
  return { kind: 'dynamic', text, reason, split, prefix };
}

/**
 * `parts` with a variable's name joined across a line continuation, which is gone before Bash reads the word: `$z\`, a
 * newline and `x` is `$zx`. The parser ends the name at the backslash.
 */
function joinNames(parts: readonly (WordPart | DoubleQuotedChild)[]): (WordPart | DoubleQuotedChild)[] {
  const joined = [...parts];
  for (let i = 0; i + 1 < joined.length; i++) {
    const [name, next] = [joined[i]!, joined[i + 1]!];
    if (name.type !== 'SimpleExpansion' || !/^\$[A-Za-z_]\w*$/.test(name.text)) continue;
    if (next.type !== 'Literal' || !next.text.startsWith('\\\n')) continue;
    const more = /^\w*/.exec(next.value)![0];
    if (!more) continue;
    joined[i] = { ...name, text: name.text + more };
    joined[i + 1] = { ...next, text: next.value.slice(more.length), value: next.value.slice(more.length) };
  }
  return joined;
}

function resolveParts(parts: readonly WordPart[], lookup: Lookup, quoted: boolean): Alternative[] | undefined {
  let alternatives: Alternative[] = [[]];
  for (const part of joinNames(parts)) {
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
      return [[{ kind: 'text', value: part.value, split: false }]];
    case 'AnsiCQuoted':
      return [[{ kind: 'text', value: ansiC(part), split: false }]];
    case 'DoubleQuoted':
    case 'LocaleString': {
      const segments: Segment[] = [{ kind: 'text', value: '', split: false }];
      for (const child of joinNames(part.parts)) {
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
    if (!word || bracesDisagree(word)) return undefined;
    const alternatives = word.parts
      ? resolveParts(word.parts, lookup, false)
      : [[{ kind: 'text', value: word.value, split: false } as Segment]];
    if (!alternatives) return undefined;
    result.push(...alternatives);
    if (result.length > maxAlternatives) return undefined;
  }
  return result;
}

/**
 * The words a word's first brace expansion makes, as text, when it has expansions: Bash expands braces before them, so
 * a name may run into a brace (`$x{a,b}` is `$xa $xb`) or out of one (`{$,}s` is `$s s`). Each is read again.
 * `undefined` when there are none, and braces can expand on parts.
 */
function braceTexts(text: string, parts: readonly WordPart[]): string[] | undefined {
  if (!/[$`]/.test(text)) return undefined;
  const at = parts.findIndex((part) => part.type === 'BraceExpansion' && braceItems(part.text) !== undefined);
  if (at === -1) return undefined;
  // Text rebuilt from the parts must be the word's, or the words read again aren't its.
  if (parts.map((part) => part.text).join('') !== text) return [];
  const before = parts
    .slice(0, at)
    .map((part) => part.text)
    .join('');
  const after = parts
    .slice(at + 1)
    .map((part) => part.text)
    .join('');
  return braceItems(parts[at]!.text)!.map((item) => before + item + after);
}

/**
 * Whether Bash expands other braces in `word` than the parser found: `{a}s,d}` is `a}s d` to Bash, as a `}` only closes
 * a brace once a `,` has been seen, but text to the parser. Neither reading can be trusted then.
 */
export function bracesDisagree(word: Word): boolean {
  if (!word.text.includes('{')) return false;
  const found: string[] = [];
  let offset = 0;
  for (const part of word.parts ?? []) {
    if (part.type === 'BraceExpansion' && braceItems(part.text)) found.push(`${offset}:${offset + part.text.length}`);
    offset += part.text.length;
  }
  if (word.parts && offset !== word.text.length) return true;
  return bashBraces(word.text).join() !== found.join();
}

/**
 * Where the `[` that starts `text` closes, as Bash reads an array literal's subscript: brackets nest, and quotes and
 * expansions are skipped. -1 when it doesn't close in `text`.
 */
export function subscriptEnd(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length;) {
    const skipped = skip(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) return i;
    i++;
  }
  return -1;
}

/** Whether Bash expands braces in a word's `text`. */
export function expandsBraces(text: string): boolean {
  return text.includes('{') && bashBraces(text).length > 0;
}

/**
 * The braces Bash expands in `text`, at the top level, as `start:end`. A `{` opens one, quotes and expansions aside, and
 * the first `}` at its level closes it once a `,` or a `..` (not just before the `}`) has been seen. With none, or when
 * what's between is no list or sequence, the `{` is text, and the next one is tried.
 */
function bashBraces(text: string): string[] {
  const spans: string[] = [];
  let i = 0;
  while (i < text.length) {
    const skipped = skip(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (text[i] !== '{') {
      i++;
      continue;
    }
    const close = closing(text, i);
    if (close === -1 || !braceItems(text.slice(i, close + 1))) {
      i++;
      continue;
    }
    spans.push(`${i}:${close + 1}`);
    i = close + 1;
  }
  return spans;
}

/** Where Bash closes the brace opened at `open`, or -1. */
function closing(text: string, open: number): number {
  let level = 0;
  let separated = false;
  for (let i = open + 1; i < text.length;) {
    const skipped = skip(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = text[i];
    if (c === '{') level++;
    else if (c === '}' && level > 0) level--;
    else if (c === '}' && separated) return i;
    else if (level === 0 && (c === ',' || (text.startsWith('..', i) && text[i + 2] !== '}'))) separated = true;
    i++;
  }
  return -1;
}

/** Where the quoted text, escape or expansion at `i` ends, or `i` when there's none there. */
function skip(text: string, i: number): number {
  const c = text[i];
  const next = text[i + 1];
  if (c === '\\') return i + 2;
  if (c === "'") return until(text, i + 1, "'", false);
  if (c === '"' || c === '`') return until(text, i + 1, c, true);
  if (c !== '$') return i;
  if (next === "'") return until(text, i + 2, "'", true);
  if (next === '"') return until(text, i + 2, '"', true);
  if (next !== '(' && next !== '{') return i;
  const [opener, closer] = next === '(' ? ['(', ')'] : ['{', '}'];
  let depth = 0;
  for (let j = i + 1; j < text.length;) {
    const skipped = skip(text, j);
    if (skipped !== j) {
      j = skipped;
      continue;
    }
    if (text[j] === opener) depth++;
    else if (text[j] === closer && --depth === 0) return j + 1;
    j++;
  }
  return text.length;
}

/** Just past the first `quote` from `from`, skipping backslash escapes when `escapes`. */
function until(text: string, from: number, quote: string, escapes: boolean): number {
  for (let j = from; j < text.length; j++) {
    if (escapes && text[j] === '\\') j++;
    else if (text[j] === quote) return j + 1;
  }
  return text.length;
}

/**
 * What a brace expansion's alternatives are as text, or `undefined` for braces that stay text. A sequence's letters and
 * digits may run into a name (`$x{1..2}` is `$x1 $x2`); Bash quotes anything else it makes.
 */
function braceItems(text: string): string[] | undefined {
  const inner = text.slice(1, -1);
  const items = splitTopLevel(inner);
  if (items.length >= 2) return items;
  return expandSequence(inner)?.map((value) => value.replaceAll(/[^A-Za-z0-9]/g, '\\$&'));
}

/** What `$'…'` stands for. unbash drops a backslash and newline in it, which Bash keeps: they're no escape there. */
function ansiC(part: AnsiCQuotedPart): string {
  const inner = part.text.slice(2, -1);
  const pieces: string[] = [];
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') continue;
    if (inner[i + 1] === '\n') {
      pieces.push(inner.slice(start, i));
      start = i + 2;
    }
    i++;
  }
  if (pieces.length === 0) return part.value;
  pieces.push(inner.slice(start));
  return pieces
    .map((piece) => {
      const [decoded] = parseWord(`$'${piece}'`)?.parts ?? [];
      return decoded?.type === 'AnsiCQuoted' ? decoded.value : piece;
    })
    .join('\\\n');
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
      if (depth > 0) depth--;
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

/**
 * Field splitting on default `IFS`: unquoted expansions split, quoted text joins its neighbours. Known values don't
 * split in a `whole` word, though they still match files.
 */
function toArgs(word: Alternative, text: string, whole = false): Arg[] {
  // An unquoted known value is a pattern too: `x='*'; cat $x` names the files it matches.
  const alternative = word.map((segment): Segment => {
    if (segment.kind !== 'text' || !segment.split) return segment;
    if (/[*?[]|[@!+]\(/.test(segment.value)) return { kind: 'dynamic', reason: 'glob', split: true };
    return whole ? { ...segment, split: false } : segment;
  });
  const dynamic = alternative.filter((segment) => segment.kind === 'dynamic');
  if (dynamic.length > 0) {
    let prefix = '';
    for (const segment of alternative) {
      if (segment.kind === 'dynamic' || segment.split) break;
      prefix += segment.value;
    }
    const reason = dynamic.find((segment) => segment.reason !== 'variable')?.reason ?? dynamic[0]!.reason;
    // A known value splits too: `"$(cmd)"$x` with `x='a b'` is two words.
    const splits = alternative.some((segment) => segment.split && (segment.kind === 'dynamic' || /[ \t\n]/.test(segment.value)));
    return [dynamicArg(text, reason, splits, prefix)];
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
