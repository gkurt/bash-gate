import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import * as fc from 'fast-check';
import { analyze, covers } from '#src/index.ts';
import { scripts } from './scripts.ts';

/**
 * The analysis against real Bash: each script runs with a `PATH` of stubs that only log their arguments, and every
 * program that ran must be one the analysis predicted, with the arguments it predicted. Predicting more than runs is
 * fine (both branches of an `if`); missing one that runs is a hole in a gate. Builtins run for real, so scripts stay
 * inside the temporary directory.
 */
const stubs = ['rm', 'ls', 'cat', 'sort', 'git', 'grep', 'echo', 'env', 'sudo', 'xargs'];
/** The first executable `name` on `PATH`, with Windows' executable extensions, as a shell would find it. */
function which(name: string): string | null {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE').split(';') : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const path = join(directory, name + extension);
      if (!statSync(path, { throwIfNoEntry: false })?.isFile()) continue;
      try {
        accessSync(path, constants.X_OK);
        return path;
      } catch {
        continue;
      }
    }
  }
  return null;
}

const bash = which('bash');
const compatibleBash = bash !== null && !(process.platform === 'win32' && /\\Windows\\System32\\bash\.exe$/i.test(bash));

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
      fc.tuple(fc.constantFrom('eval', '/bin/bash -c'), block).map(([how, code]) => `${how} ${quote(code)}`),
      fc.tuple(block, fc.constantFrom('EXIT', 'ERR', 'DEBUG')).map(([code, signal]) => `trap ${quote(code)} ${signal}`),
      fc.constantFrom('trap - EXIT', 'trap - ERR', "trap '' DEBUG"),
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
  // On Windows a process substitution still running holds the directory for a moment (EBUSY).
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  /** Runs the script in Bash and returns the argv of every stub that ran. */
  function run(script: string): string[][] {
    // A fresh directory each time: a process substitution may still be running after Bash exits.
    const logs = mkdtempSync(join(dir, 'logs-'));
    // From a file: Git Bash's runtime expands braces and globs in the arguments a Windows process gives it.
    writeFileSync(join(dir, 'script.sh'), script);
    // FUNCNEST only stops runaway recursion: it can make Bash run less than the analysis predicts, never more.
    const result = spawnSync(bash!, ['--noprofile', '--norc', 'script.sh'], {
      cwd: dir,
      env: { PATH: bin, BASH_GATE_LOGS: logs, FUNCNEST: '8' },
      stdio: 'ignore',
      timeout: 10_000,
    });
    if (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT') throw new Error(`Bash didn't finish:\n${script}`);
    if (result.error) throw result.error;
    const ran = readdirSync(logs).map((file) => readFileSync(join(logs, file), 'utf8').split('\x1f'));
    rmSync(logs, { recursive: true, force: true });
    return ran;
  }

  /** What ran that the analysis doesn't cover; `excuse` lets findings account for what they hide. */
  function missed(script: string, ran: string[][], excuse: boolean): string[] {
    const analysis = analyze(script);
    const checked = excuse ? analysis : { ...analysis, findings: [] };
    return ran.filter((argv) => !covers(checked, argv)).map((argv) => argv.join(' '));
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
