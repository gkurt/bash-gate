import type { Analysis, Arg, FindingKind, Invocation } from './types.ts';

/** Findings that leave code unseen, such as a script only known at run time: any process is accounted for. */
const unseen = new Set<FindingKind>([
  'parse-error',
  'too-deep',
  'unknown-syntax',
  'dynamic-script',
  'exec-config',
  'dynamic-command',
  'unknown-alias',
]);
/** Findings that leave one call's program unknown: that invocation may be any program. */
const unsure = new Set<FindingKind>(['loads-code']);
const shells = new Set(['bash', 'sh']);

/** The wrappers an invocation runs under, outermost first, without the shells between them. */
export function wrappers(invocation: Invocation): string[] {
  return invocation.via.filter((program) => !shells.has(program));
}

/**
 * The invocations that predict a process a run of the analysed script starts: `argv` is the program's file name, then
 * the arguments after the first, and `via` the wrappers it runs under, outermost first, shells left out (`['xargs']`
 * for what `xargs` starts). Predicting means the same program, with each static argument equal and each dynamic one
 * standing for the words it may become.
 */
export function predicting(analysis: Analysis, argv: string[], via: string[] = []): Invocation[] {
  const anyProgram = new Set(analysis.findings.filter((finding) => unsure.has(finding.kind)).map((finding) => finding.span.join()));
  return analysis.invocations.filter(
    (invocation) =>
      invocation.kind === 'external' &&
      sameList(wrappers(invocation), via) &&
      predicts(invocation, argv, anyProgram.has(invocation.span.join())),
  );
}

/**
 * Whether the analysis accounts for a process a run of its script starts (promise S1): an invocation predicts it, or a
 * finding says the analysis couldn't see the code that started it. `argv` and `via` are as for `predicting`.
 */
export function covers(analysis: Analysis, argv: string[], via: string[] = []): boolean {
  return analysis.findings.some((finding) => unseen.has(finding.kind)) || predicting(analysis, argv, via).length > 0;
}

/**
 * Whether the invocation predicts this run: the program, then each argument where it stands. A dynamic word that may
 * split stands for any number of words, one that may not for exactly one word that starts with its static prefix.
 */
function predicts(invocation: Invocation, argv: string[], anyProgram: boolean): boolean {
  const [first, ...rest] = invocation.argv;
  const head: Arg =
    invocation.program === null
      ? first!
      : anyProgram
        ? { kind: 'dynamic', text: '', reason: 'placeholder', split: false, prefix: '' }
        : { kind: 'static', value: invocation.program };
  return matches([head, ...rest], argv, invocation.open);
}

function matches(pattern: Arg[], words: string[], open: boolean): boolean {
  const [arg, ...rest] = pattern;
  if (!arg) return open || words.length === 0;
  if (arg.kind === 'dynamic' && arg.split) return words.some((_, i) => matches(rest, words.slice(i), open)) || matches(rest, [], open);
  const [word, ...after] = words;
  if (word === undefined) return false;
  if (arg.kind === 'static' ? arg.value !== word : !word.startsWith(arg.prefix)) return false;
  return matches(rest, after, open);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
