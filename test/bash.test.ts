import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fc from 'fast-check';
import { analyze, type Arg, type FindingKind, type Invocation } from '#src/index.ts';

/**
 * The analysis against real Bash: each script runs with a `PATH` of stubs that only log their arguments, and every
 * program that ran must be one the analysis predicted, with the arguments it predicted. Predicting more than runs is
 * fine (both branches of an `if`); missing one that runs is a hole in a gate. Builtins run for real, so scripts stay
 * inside the temporary directory.
 */
const scripts = [
  'cmd=rm; $cmd -rf x',
  '"r"m -rf x',
  '\\rm x',
  '{rm,-rf,x}',
  'rm {,-rf} x',
  'x="a  b"; cat $x "$x" pre$x',
  'f() { cat "$@"; }; f a b',
  'ls() { cat inside; }; ls; command ls x',
  'shopt -s expand_aliases\nalias l="ls -la"\nl x',
  'shopt -s expand_aliases; alias l="ls -la"; l x; ls z',
  'eval "cat a; ls b"',
  `f() { eval 'f() { cat redefined; }; f'; }; f`,
  `exec /bin/bash -c "eval 'cat nested; ls child'"`,
  `f() { cat exported; }; export -f f; exec /bin/bash -c f`,
  "trap 'rm x' EXIT; ls",
  "x=ls; trap 'f; $x y' EXIT; f() { cat late; }; x=sort",
  'cat $(ls x) <(sort y)',
  'for f in a b; do cat "$f"; done',
  'if true; then cat a; else ls b; fi',
  'cat <<EOF\n$(ls x)\nEOF',
  '(( a[$(ls q)] = 1 ))',
  '(( a[$(cat arithmetic)] = 1 ))',
  'echo $(( $(cat arithmetic) ))',
  'for ((i=$(cat arithmetic); i<1; i++)); do :; done',
  'let "i=$(cat arithmetic)"',
  '[[ $(cat arithmetic) -eq 1 ]]',
  'a[$(cat arithmetic)]=value',
  'echo "${a[$(cat arithmetic)]}"',
  's=abcdef; echo "${s:$(cat arithmetic)}"',
  'declare -i n=$(cat arithmetic)',
  'mapfile -C cat -c 1 arr <<< "line"',
  "compgen -C 'ls -1' x",
  'echo `ls y`',
  'enable -n echo; echo hi',
  'x=$(cat a) y=$(ls b); cat "$x"',
  'case a in a) cat 1;; b) ls 2;; esac',
  'git -C . status --short',
  'exec cat a',
  'sudo rm -rf x; env A=1 cat y; xargs grep z < /dev/null',
  'set -- -rf x; rm "$@"',
  'i=0; while (( i < 2 )); do cat $i; i=$((i + 1)); done',
  'x=ls; y=ls; z=ls; for i in 1 2 3; do $z -rf x; z=$y; y=$x; x=rm; done',
  'shopt -s expand_aliases\nif :; then\nalias rm=cat\nrm -rf x\nfi\nrm y',
  'shopt -s expand_aliases\nf() { ls a; }\nalias ls=cat\nf; ls b; x=$(ls c)',
  'shopt -s expand_aliases\nalias s="sudo "\nalias l="ls -la"\ns l x',
  'shopt -s expand_aliases\nalias s="sudo "\nalias q="; cat q"\ns q',
  "shopt -s expand_aliases\neval $'alias ls=cat\\nls a'; eval 'alias rm=cat; rm b'",
  'shopt -s expand_aliases\nif [ -n "$x" ]; then alias rm=cat; fi\nrm a',
  "/bin/sh -c 'alias ls=cat\nls a'",
  "/bin/bash --posix -c 'alias ls=cat\nls a'; /bin/bash -O expand_aliases -c 'alias rm=cat\nrm b'",
  'set -o posix\nalias ls=cat\nls a',
  "PS4='+$(ls ps4) '; set -x; cat a",
  'x=<(sort s) y=1 cat a<(ls l)b',
  'f() { cat body; }; $unset f; $unset ls x',
  'x=a; local x=b; cat $x; f() { local x=c; cat $x; }; f; cat $x',
];

const stubs = ['rm', 'ls', 'cat', 'sort', 'git', 'grep', 'echo', 'env', 'sudo', 'xargs'];
const bash = Bun.which('bash');
const compatibleBash = bash !== null && !(process.platform === 'win32' && /\\Windows\\System32\\bash\.exe$/i.test(bash));

/** Findings that leave code unseen, such as a command name only known at run time (`eval`?): any run is accounted for. */
const blind = new Set<FindingKind>(['parse-error', 'too-deep', 'unknown-syntax', 'dynamic-script', 'exec-config', 'dynamic-command']);
/** Findings that leave one call's program unknown: that invocation may be any program. */
const unsure = new Set<FindingKind>(['loads-code', 'unknown-alias']);

/**
 * Whether the invocation predicts this run: the program, then each argument where it stands. A dynamic word that may
 * split stands for any number of words, one that may not for exactly one word that starts with its static prefix.
 */
function covers(invocation: Invocation, argv: string[], anyProgram: boolean): boolean {
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

/**
 * Generated scripts: random mixes of the constructs the analysis follows, over a few shared names, so variables,
 * functions and aliases get set in one place and used in another. Every script is valid Bash and always finishes.
 */
const runs = Number(process.env.BASH_RUNS ?? 100);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const programs = ['cat', 'ls', 'rm', 'sort', 'grep', 'git'];
const variables = ['v1', 'v2', 'v3'];
const functions = ['f1', 'f2'];
const aliases = ['a1', 'a2'];
const values = ['a', '-rf', 'x y', 'cat', 'rm -rf', 'f1', 'a1', ''];
const expansions = [
  '$v',
  '"$v"',
  '${v}x',
  '${v:-a}',
  '"${v:-cat}"',
  '${v:=rm}',
  '${v:+-rf}',
  '${v/a/b}',
  '${v#-}',
  '${!v}',
  '${#v}',
  '"${v[@]}"',
  '${v[1]}',
];
const depth = { depthIdentifier: 'script', maxDepth: 4, depthSize: 'small' } as const;

/** Every way to write the string as one word that Bash reads back as exactly that string. */
function spelled(value: string): fc.Arbitrary<string> {
  const quoted = [quote(value), `"${value}"`, `$'${value}'`];
  if (!/^[\w-]+$/.test(value)) return fc.constantFrom(...quoted);
  return fc.constantFrom(value, `\\${value}`, `${value[0]}""${value.slice(1)}`, ...quoted);
}

const { script: generatedScript } = fc.letrec<{ word: string; command: string; block: string; script: string }>((tie) => {
  const command = tie('command');
  const word = tie('word');
  const block = tie('block');
  const words = fc.array(word, { maxLength: 3 }).map((list) => list.join(' '));
  const variable = fc.constantFrom(...variables);
  const name = fc.oneof(
    { weight: 2, arbitrary: fc.constantFrom(...programs).chain(spelled) },
    { weight: 2, arbitrary: fc.constantFrom(...functions, ...aliases, 'h1', 'echo') },
    { weight: 1, arbitrary: fc.constantFrom(...programs).map((program) => `command ${program}`) },
  );
  const redirect = fc.constantFrom('', ' >out', ' 2>/dev/null', ' </dev/null');
  const simple = fc
    .tuple(fc.option(fc.tuple(variable, word), { nil: undefined }), name, words, redirect)
    .map(([prefix, program, args, to]) => `${prefix ? `${prefix[0]}=${prefix[1]} ` : ''}${program} ${args}${to}`);
  const literal = fc.constantFrom(...values).chain(spelled);
  const literalCommand = fc.tuple(name, fc.array(literal, { maxLength: 3 })).map(([program, args]) => [program, ...args].join(' '));
  return {
    word: fc.oneof(
      depth,
      literal,
      fc.tuple(variable, fc.constantFrom(...expansions)).map(([v, form]) => form.replaceAll('v', v)),
      fc.constantFrom('"$@"', '$@', '"$*"', '$1', '"$2"', '$#', '{a,-rf}', 'x{1,2}', '*.sh', '$((1 + 2))', '$((c + 1))'),
      command.map((code) => `"$(${code})"`),
      command.map((code) => `$(${code})`),
      command.map((code) => `<(${code})`),
    ),
    command: fc.oneof(
      depth,
      simple,
      // A command name from a variable set just before, so it stays known unless the branches disagree: a name the
      // analysis can't resolve hides the rest of the script from the check.
      fc
        .tuple(variable, fc.constantFrom(...programs, ...functions, 'cat -rf'), words)
        .map(([v, program, args]) => `${v}=${quote(program)}\n$${v} ${args}`),
      fc.tuple(variable, word).map(([v, value]) => `${v}=${value}`),
      fc
        .tuple(fc.constantFrom('', 'local ', 'declare ', 'export '), variable, fc.constantFrom('=', '+='), word)
        .map((parts) => parts.join('')),
      fc.tuple(variable, words).map(([v, list]) => `${v}=(${list})`),
      fc.tuple(fc.constantFrom('unset', 'export'), variable).map((parts) => parts.join(' ')),
      // Quoted: unbash can't parse `$''` or a process substitution as a here-string (README, Known gaps).
      fc.tuple(variable, word).map(([v, value]) => `read -r ${v} <<< "x${value}"`),
      words.map((list) => `set -- ${list}`),
      fc.constant('shift'),
      fc.tuple(fc.constantFrom('env v1=a', 'sudo', 'exec'), simple).map((parts) => parts.join(' ')),
      simple.map((code) => `xargs ${code} </dev/null`),
      fc.constantFrom(...programs).map((program) => `hash -p bin/${program} h1`),
      fc.constant('enable -n echo'),
      // Literal words only: Bash expands an alias again in each substitution it contains, without end.
      fc.tuple(fc.constantFrom(...aliases), fc.oneof(literalCommand, fc.constant('sudo '))).map(([a, code]) => `alias ${a}=${quote(code)}`),
      fc.tuple(fc.constantFrom(...functions), block).map(([f, body]) => `${f}() {\n${body}\n}`),
      fc
        .tuple(fc.constantFrom('eval', '/bin/bash -c', 'trap'), block)
        .map(([how, code]) => `${how} ${quote(code)}${how === 'trap' ? ' EXIT' : ''}`),
      fc.tuple(command, fc.constantFrom('&&', '||', '|'), command).map((parts) => parts.join(' ')),
      command.map((code) => `! ${code}`),
      block.map((body) => `(\n${body}\n)`),
      block.map((body) => `{\n${body}\n}`),
      fc.tuple(command, block, block).map(([test, yes, no]) => `if ${test}\nthen\n${yes}\nelse\n${no}\nfi`),
      fc.tuple(word, block, block).map(([subject, a, other]) => `case ${subject} in\na)\n${a}\n;;\n*)\n${other}\n;;\nesac`),
      fc.tuple(variable, words, block).map(([v, list, body]) => `for ${v} in ${list}; do\n${body}\ndone`),
      // One counter for every loop: a nested loop leaves it at 2, so the outer one ends too.
      block.map((body) => `c=0\nwhile (( c < 2 )); do\n${body}\nc=$((c + 1))\ndone`),
      word.map((value) => `[[ -n ${value} ]]`),
    ),
    block: fc.array(command, { minLength: 1, maxLength: 3 }).map((list) => list.join('\n')),
    script: fc
      .tuple(fc.boolean(), fc.array(command, { minLength: 1, maxLength: 5 }))
      .map(([aliasing, list]) => [...(aliasing ? ['shopt -s expand_aliases'] : []), ...list].join('\n')),
  };
});

describe.skipIf(!compatibleBash)('against bash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bash-gate-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // One log per process: substitutions run alongside the command, and their writes would interleave.
  const stub = `#!/bin/sh\n{ printf '%s' "\${0##*/}"; for a in "$@"; do printf '\\037%s' "$a"; done; } > "$BASH_GATE_LOGS/$$"\n`;
  for (const name of stubs) {
    writeFileSync(join(bin, name), stub);
    chmodSync(join(bin, name), 0o755);
  }
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Runs the script in Bash and returns the argv of every stub that ran. */
  function run(script: string): string[][] {
    // A fresh directory each time: a process substitution may still be running after Bash exits.
    const logs = mkdtempSync(join(dir, 'logs-'));
    // From a file: Git Bash's runtime expands braces and globs in the arguments a Windows process gives it.
    writeFileSync(join(dir, 'script.sh'), script);
    // FUNCNEST only stops runaway recursion: it can make Bash run less than the analysis predicts, never more.
    const result = Bun.spawnSync([bash!, '--noprofile', '--norc', 'script.sh'], {
      cwd: dir,
      env: { PATH: bin, BASH_GATE_LOGS: logs, FUNCNEST: '8' },
      timeout: 10_000,
    });
    if (result.exitedDueToTimeout) throw new Error(`Bash didn't finish:\n${script}`);
    const ran = readdirSync(logs).map((file) => readFileSync(join(logs, file), 'utf8').split('\x1f'));
    rmSync(logs, { recursive: true, force: true });
    return ran;
  }

  /** What ran that no invocation of the analysis covers; `excuse` lets findings account for what they hide. */
  function missed(script: string, ran: string[][], excuse: boolean): string[] {
    const { invocations, findings } = analyze(script);
    const excused = excuse ? findings : [];
    if (excused.some((finding) => blind.has(finding.kind))) return [];
    const unsureSpans = new Set(excused.filter((finding) => unsure.has(finding.kind)).map((finding) => finding.span.join()));
    const predicted = invocations.filter(
      (invocation) => invocation.kind === 'external' && invocation.via.every((program) => program === 'bash' || program === 'sh'),
    );
    return ran
      .filter((argv) => !predicted.some((invocation) => covers(invocation, argv, unsureSpans.has(invocation.span.join()))))
      .map((argv) => argv.join(' '));
  }

  for (const script of scripts) {
    test(JSON.stringify(script), () => {
      const ran = run(script);
      expect(ran.length).toBeGreaterThan(0);
      expect(missed(script, ran, false)).toEqual([]);
    });
  }

  test(
    'generated scripts',
    () => {
      fc.assert(
        fc.property(generatedScript, (script) => {
          const misses = missed(script, run(script), true);
          if (misses.length > 0) throw new Error(`Ran but not predicted: ${misses.join(' | ')}\n--- script ---\n${script}`);
        }),
        { numRuns: runs },
      );
    },
    { timeout: Math.max(5_000, runs * 500) },
  );
});
