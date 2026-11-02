import * as fc from 'fast-check';
import { unseen } from '#src/cover.ts';
import { analyze, type Analysis } from '#src/index.ts';
import { generatedScript } from './generated.ts';
import { hiding, scripts } from './scripts.ts';

/**
 * Mutated scripts: the hand-written and generated ones, changed a few characters or tokens at a time, so the parser
 * meets text no generator would write. The generators only write constructs the analysis already follows; a mutant
 * is whatever it is, and only Bash says what it runs.
 */

/**
 * Seeds have no absolute paths, and mutants may not make one: a mutation can turn any word into a redirection target,
 * and `> /bin/bash` would overwrite the shell. `bin/` is the stub directory, which each run restores.
 */
const relative = (script: string) => script.replaceAll('/bin/', 'bin/').replaceAll('/dev/null', 'null');
const seeds = [...scripts, ...hiding].map(relative);

/** Whether a mutant can only reach files under the run's directory: no absolute path, `~`, or escape that makes `/`. */
function confined(script: string): boolean {
  if (script.replaceAll(/(?<![\w./])bin\//g, '').includes('/')) return false;
  if (script.includes('~')) return false;
  // `$'\57'`, `$'\x2f'` and the like: escapes that may spell a slash.
  if (/\\[0-7xuU]/.test(script)) return false;
  // `$_` starts as the shell's own path, and `PWD`, `PATH`, `BASH` and the log directory are absolute.
  return !script.replaceAll('expand_aliases', '').includes('_') && !/BASH|PWD|PATH|HOME|LOGS/.test(script);
}

/** What a mutation inserts: the characters and tokens where Bash's grammar turns, none of which spells a path. */
const tokens = [
  "'",
  '"',
  '\\',
  '`',
  "$'",
  '$"',
  '$',
  '#',
  ' #',
  '\\\n',
  '\n',
  '\r',
  '\t',
  ' ',
  ';',
  '&',
  '|',
  '(',
  ')',
  '{',
  '}',
  '<',
  '>',
  '<<<',
  '!',
  '*',
  '?',
  '[',
  ']',
  '=',
  '-',
  ',',
  ':',
  '@(',
  '!(',
  '+(',
  '*(',
  '?(',
  ';;',
  ';&',
  ';;&',
  'esac',
  'in',
  'do',
  'done',
  'then',
  'fi',
  '}',
  '[[',
  ']]',
  '((',
  '))',
  '$(',
  '${',
  '$((',
  '<(',
  '>(',
  '&&',
  '||',
  '|&',
  '&>',
  '"$@"',
];
const wraps: [string, string][] = [
  ["'", "'"],
  ['"', '"'],
  ["$'", "'"],
  ['$"', '"'],
  ['`', '`'],
  ['$(', ')'],
  ['(', ')'],
  ['{ ', '; }'],
  ['\\', ''],
  ['#', '\n'],
];
const openers = ['<<D', "<<'D'", '<<"D"', '<<\\D', '<<-D', '<< D', "<<D''", "<<$'D'", '<<"D"D', '<<D\\\n', "<<'D\nD'"];
const closers = ['D', '\tD', 'D ', ' D', "'D'", 'DD', 'D\\', 'D;'];
const subjects = ['a', '"$1"', '$v1', "'a b'", "$'a'", "''", '*'];
const patterns = ['*', 'a|*', '(*)', '@(a|*)', '!(x)', '+(?)', '*(a)|?(a)', '[a]*', '\\*', '"*"', "'*'", "$'*'", '*\\)', '(a)|(*'];
const ends = [';;', ';&', ';;&'];
const prefixes = ['shopt -s extglob', 'shopt -s expand_aliases', 'shopt -u expand_aliases', 'set -o posix', 'set -f'];

type Mutation = { op: number; at: number; length: number; pick: number; other: number };
const mutation = fc.record({ op: fc.nat(8), at: fc.nat(), length: fc.nat(6), pick: fc.nat(), other: fc.nat() });
const of = <T>(list: readonly T[], i: number) => list[i % list.length]!;

/** Where the `count`-th line after `at` ends, or the end of the script. */
function lineEnd(script: string, at: number, count: number): number {
  let end = script.indexOf('\n', at);
  for (let i = 0; i < count && end !== -1; i++) end = script.indexOf('\n', end + 1);
  return end === -1 ? script.length : end;
}

function mutate(script: string, { op, at, length, pick, other }: Mutation): string {
  const start = at % (script.length + 1);
  const stop = Math.min(script.length, start + 1 + length);
  const [before, inside, after] = [script.slice(0, start), script.slice(start, stop), script.slice(stop)];
  switch (op) {
    case 0:
      return before + of(tokens, pick) + script.slice(start);
    case 1:
      return before + of(tokens, pick) + after;
    case 2:
      return before + after;
    case 3:
      return before + inside + inside + after;
    case 4: {
      const [open, close] = of(wraps, pick);
      return before + open + inside + close + after;
    }
    case 5: {
      // A here-document opened mid-line, closed (or not) some lines later: the lines between become its body.
      const end = lineEnd(script, start, length % 3);
      return `${before}${of(openers, pick)}${script.slice(start, end)}\n${of(closers, other)}\n${script.slice(end + 1)}`;
    }
    case 6: {
      // Lines inside a case arm, under a pattern Bash may read differently from the parser.
      const line = script.lastIndexOf('\n', start - 1) + 1;
      const end = lineEnd(script, start, length % 3);
      const arm = `case ${of(subjects, pick)} in ${of(patterns, other)})`;
      return `${script.slice(0, line)}${arm}\n${script.slice(line, end)}\n${of(ends, pick + other)} esac\n${script.slice(end + 1)}`;
    }
    case 7:
      return `${of(prefixes, pick)}\n${script}`;
    default: {
      // A line of another seed: a construct where the parser and Bash may disagree on where it ends.
      const donor = of(seeds, other).split('\n');
      return before + of(donor, pick) + script.slice(start);
    }
  }
}

/** Whether the analysis already accounts for anything the script may run, through a finding. */
const blind = (analysis: Analysis) => analysis.findings.some((finding) => unseen.has(finding.kind));

/**
 * Mutants the analysis claims to see through: confined to the run's directory, and with no finding that leaves code
 * unseen. A parse error is such a finding, so most of the mutants it discards, Bash would reject too.
 */
export const mutatedScript = fc
  .tuple(fc.oneof(fc.constantFrom(...seeds), generatedScript.map(relative)), fc.array(mutation, { minLength: 1, maxLength: 4 }))
  .map(([seed, mutations]) => mutations.reduce(mutate, seed))
  .filter((script) => confined(script) && !blind(analyze(script)));
