import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import * as fc from 'fast-check';
import { analyze, covers } from '#src/index.ts';
import { generatedScript } from './generated.ts';
import { mutatedScript } from './mutated.ts';
import { hiding, scripts } from './scripts.ts';

/**
 * The analysis against real Bash: each script runs with a `PATH` of stubs that only log their arguments, and every
 * program that ran must be one the analysis predicted, with the arguments it predicted. Predicting more than runs is
 * fine (both branches of an `if`); missing one that runs is a hole in a gate. Builtins run for real, so scripts stay
 * inside the temporary directory.
 */
const stubs = ['rm', 'ls', 'cat', 'sort', 'git', 'grep', 'echo', 'env', 'sudo', 'xargs'];
/** Shells, for scripts that name them by relative path (`bin/bash -c`): logged like a stub, then run. */
const shells = { bash: '/bin/bash', sh: '/bin/sh' };
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

const runs = Number(process.env.BASH_RUNS ?? 100);
const mutationRuns = Number(process.env.MUTATION_RUNS ?? 100);
/** How long a mutant may run: one may loop forever, and what it ran until then is still checked. */
const mutantSeconds = 3;

/**
 * Runs `../script.sh` in a process group of its own, with the stubs' `PATH` (the first entry of its own), then waits
 * for whatever the script left running. Past `$1` seconds, the group is killed and `../timeout` left: by the watchdog
 * while the script runs, then by the harness, which stops waiting a moment later, as a kill on Windows may not take.
 * The watchdog holds no output of the harness's: one that outlived its kill would keep a reader waiting.
 */
const harness = `set -m
PATH=\${PATH%%:*} "$BASH" --noprofile --norc ../script.sh </dev/null >/dev/null 2>&1 &
job=$!
{ sleep "$1"; kill -KILL -- -"$job" && : >../timeout; } </dev/null >/dev/null 2>&1 &
watchdog=$!
wait "$job"
while kill -0 -- -"$job" 2>/dev/null && (( SECONDS <= $1 + 1 )); do sleep 0.05; done
kill -KILL -- -"$job" 2>/dev/null && : >../timeout
kill -KILL -- -"$watchdog" 2>/dev/null
`;
/**
 * Logs the argv to a file of its own, even when the process execs another (`exec bash -c 'exec cat'`): substitutions
 * run alongside the command, and their writes would interleave. Each ends with \x1e, so a log cut short by a kill
 * isn't read as a shorter argv.
 */
const log = `n=$$; while ! { set -C; : > "$BASH_GATE_LOGS/$n"; } 2>/dev/null; do n=$n.; done
{ printf '%s' "\${0##*/}"; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\036'; } >| "$BASH_GATE_LOGS/$n"
`;
/**
 * A stub named `name`, which logs and then runs `then`, only when it was run as a program: its `$0` is then the path
 * it was found at. A shell running it as a script by name (`bash grep`, which looks for a script on `PATH`) or
 * sourcing it leaves another `$0`, and does what a real program wouldn't: run it as shell code.
 */
const program = (name: string, then = '') => `#!/bin/sh\ncase $0 in\n*/${name})\n${log}${then};;\nesac\n`;

describe.skipIf(!compatibleBash)('against bash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bash-gate-'));
  // The script's working directory, with the stubs in it: a script may write anywhere below it, stubs included.
  const work = join(dir, 'work');
  const bin = join(work, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, 'harness.sh'), harness);
  const programs = new Map([
    ...stubs.map((name) => [name, program(name)] as const),
    ...Object.entries(shells).map(([name, path]) => [name, program(name, `exec ${path} "$@"\n`)] as const),
  ]);
  // On Windows a process just killed holds the directory for a moment (EBUSY).
  const remove = (path: string) => rmSync(path, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  afterAll(() => remove(dir));

  /** Undoes what the last script wrote. Only stubs it changed are written again: Windows scans a new executable first. */
  function fresh() {
    for (const entry of readdirSync(work)) if (entry !== 'bin') remove(join(work, entry));
    for (const entry of readdirSync(bin)) if (!programs.has(entry)) remove(join(bin, entry));
    for (const [name, text] of programs) {
      const path = join(bin, name);
      if (!statSync(path, { throwIfNoEntry: false }) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text, { mode: 0o755 });
    }
  }

  /**
   * Runs the script in Bash and returns the argv of every stub that ran. Past `seconds`, what's still running is killed:
   * an error, unless the run is `bounded` (a mutant may loop forever), when logs cut short are left out.
   */
  function run(script: string, { seconds = 10, bounded = false } = {}): string[][] {
    fresh();
    const logs = mkdtempSync(join(dir, 'logs-'));
    // From a file: Git Bash's runtime expands braces and globs in the arguments a Windows process gives it.
    writeFileSync(join(dir, 'script.sh'), script);
    const timeout = join(dir, 'timeout');
    remove(timeout);
    // FUNCNEST only stops runaway recursion: it can make Bash run less than the analysis predicts, never more.
    const result = spawnSync(bash!, ['--noprofile', '--norc', '../harness.sh', String(seconds)], {
      cwd: work,
      env: { PATH: [bin, process.env.PATH].join(delimiter), BASH_GATE_LOGS: logs, FUNCNEST: '8' },
      stdio: 'ignore',
      timeout: (seconds + 10) * 1000,
    });
    const stuck = result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT';
    if (result.error && !(stuck && bounded)) throw result.error;
    const timedOut = stuck || statSync(timeout, { throwIfNoEntry: false }) !== undefined;
    if (timedOut && !bounded) throw new Error(`Bash didn't finish:\n${script}`);
    const texts = readdirSync(logs).map((file) => readFileSync(join(logs, file), 'utf8'));
    remove(logs);
    const cut = texts.filter((text) => !text.endsWith('\x1e'));
    if (cut.length > 0 && !timedOut) throw new Error(`A stub never finished its log: ${JSON.stringify(cut)}`);
    return texts.filter((text) => text.endsWith('\x1e')).map((text) => text.slice(0, -1).split('\x1f'));
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

  for (const script of hiding) {
    test(`hiding ${JSON.stringify(script)}`, () => {
      const ran = run(script);
      expect(ran.length).toBeGreaterThan(0);
      expect(missed(script, ran, true)).toEqual([]);
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
        { numRuns: runs, includeErrorInReport: true },
      );
    },
    { timeout: Math.max(5_000, runs * 1_000) },
  );

  // The parser against Bash: mutants break the constructs the generator writes, and whatever Bash makes of one, the
  // analysis must predict what it runs, or report that it can't see it.
  test(
    'mutated scripts',
    () => {
      fc.assert(
        fc.property(mutatedScript, (script) => {
          const misses = missed(script, run(script, { seconds: mutantSeconds, bounded: true }), true);
          if (misses.length > 0) throw new Error(`Ran but not predicted: ${misses.join(' | ')}\n--- script ---\n${script}`);
        }),
        { numRuns: mutationRuns, includeErrorInReport: true },
      );
    },
    { timeout: Math.max(5_000, mutationRuns * (mutantSeconds + 1) * 1000) },
  );
});
