import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, sep } from 'node:path';
import * as fc from 'fast-check';
import { analyze, covers, predicting, type Analysis, type Arg, type Invocation } from '#src/index.ts';
import { relativePath, resolvePath } from '#src/paths.ts';
import { blind, seenScript } from './generated.ts';
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
 * Logs the directory it runs in (before \x1d) and the argv to a file of its own, even when the process execs another
 * (`exec bash -c 'exec cat'`): substitutions run alongside the command, and their writes would interleave. Each ends
 * with \x1e, so a log cut short by a kill isn't read as a shorter argv.
 */
const log = `n=$$; while ! { set -C; : > "$BASH_GATE_LOGS/$n"; } 2>/dev/null; do n=$n.; done
{ printf '%s\\035%s' "$(pwd -P)" "\${0##*/}"; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\036'; } >| "$BASH_GATE_LOGS/$n"
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
  // A home of its own: an interactive or login shell a script starts reads its startup files from there.
  const home = join(dir, 'home');
  mkdirSync(home);
  const bin = join(work, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, 'harness.sh'), harness);
  const programs = new Map([
    ...stubs.map((name) => [name, program(name)] as const),
    ...Object.entries(shells).map(([name, path]) => [name, program(name, `exec ${path} "$@"\n`)] as const),
  ]);
  // On Windows a process just killed holds the directory for a moment (EBUSY).
  const remove = (path: string) => rmSync(path, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  // A mutant's process Windows didn't kill may hold it past the retries: leaving the temporary directory is harmless.
  afterAll(() => {
    try {
      remove(dir);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
  });

  /** `path` as Bash sees it, symlinks resolved: what a stub's `pwd -P` says. */
  const physical = (path: string) =>
    compatibleBash ? spawnSync(bash, ['-c', 'pwd -P'], { cwd: path, encoding: 'utf8' }).stdout.trim() : path;
  const shellWork = physical(work);

  /**
   * Undoes what the last script wrote, in the run's home too (`cd`). Only stubs it changed are written again: Windows
   * scans a new executable first.
   */
  function fresh() {
    for (const entry of readdirSync(dir)) if (!['work', 'home', 'harness.sh'].includes(entry)) remove(join(dir, entry));
    for (const entry of readdirSync(home)) remove(join(home, entry));
    for (const entry of readdirSync(work)) if (entry !== 'bin') remove(join(work, entry));
    for (const entry of readdirSync(bin)) if (!programs.has(entry)) remove(join(bin, entry));
    for (const [name, text] of programs) {
      const path = join(bin, name);
      if (!statSync(path, { throwIfNoEntry: false }) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text, { mode: 0o755 });
    }
  }

  /** Every file under `dir` but the harness's own, by its path from `work` (`/`-separated), with its contents. */
  function files(): Map<string, string> {
    const found = new Map<string, string>();
    const visit = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (path === dir && (entry.name.startsWith('logs-') || entry.name === 'timeout')) continue;
        const full = join(path, entry.name);
        if (entry.isDirectory()) visit(full);
        else found.set(relative(work, full).split(sep).join('/'), readFileSync(full, 'latin1'));
      }
    };
    visit(dir);
    return found;
  }

  /**
   * Runs the script in Bash and returns what it did: the argv of every stub that ran, with the directory it ran in (from
   * `work`), and the files it wrote. Past `seconds`, what's still running is killed: an error, unless the run is
   * `bounded` (a mutant may loop forever), when logs cut short are left out.
   */
  function run(script: string, { seconds = 10, bounded = false } = {}): Run {
    fresh();
    const logs = mkdtempSync(join(dir, 'logs-'));
    // From a file: Git Bash's runtime expands braces and globs in the arguments a Windows process gives it.
    writeFileSync(join(dir, 'script.sh'), script);
    const timeout = join(dir, 'timeout');
    remove(timeout);
    const before = files();
    // FUNCNEST only stops runaway recursion: it can make Bash run less than the analysis predicts, never more.
    const result = spawnSync(bash!, ['--noprofile', '--norc', '../harness.sh', String(seconds)], {
      cwd: work,
      env: { PATH: [bin, process.env.PATH].join(delimiter), HOME: home, BASH_GATE_LOGS: logs, FUNCNEST: '8' },
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
    const ran = texts
      .filter((text) => text.endsWith('\x1e'))
      .map((text) => {
        const [cwd = '', argv = ''] = text.slice(0, -1).split('\x1d');
        return { argv: argv.split('\x1f'), cwd: relativePath(cwd, shellWork) };
      });
    const after = files();
    return { ran, written: [...after].filter(([path, text]) => before.get(path) !== text).map(([path]) => path) };
  }

  /**
   * What the run did that the analysis doesn't account for: a process no invocation predicts, one predicted only in
   * another directory, or a file no invocation writes. `excuse` lets findings account for what they hide.
   */
  function faults(script: string, { ran, written }: Run, excuse: boolean): string[] {
    const analysis = analyze(script);
    if (excuse && blind(analysis)) return [];
    const checked: Analysis = excuse ? analysis : { ...analysis, findings: [] };
    const missed = ran.filter(({ argv }) => !covers(checked, argv));
    const misplaced = ran.filter(({ argv, cwd }) => {
      const predicted = predicting(checked, argv);
      return predicted.length > 0 && !predicted.some((invocation) => [undefined, cwd].includes(place(invocation)));
    });
    const unwritten = written.filter(
      (path) =>
        !analysis.invocations.some((invocation) =>
          invocation.writes.some((write) => [undefined, path].includes(target(invocation, write))),
        ),
    );
    return [
      ...missed.map(({ argv }) => `ran but not predicted: ${argv.join(' ')}`),
      ...misplaced.map(({ argv, cwd }) => `ran in ${cwd}, not where predicted: ${argv.join(' ')}`),
      ...unwritten.map((path) => `wrote but not predicted: ${path}`),
    ];
  }

  function expectFaithful(script: string, excuse: boolean, options?: { seconds?: number; bounded?: boolean }): Run {
    const result = run(script, options);
    const found = faults(script, result, excuse);
    if (found.length > 0) throw new Error(`${found.join('\n')}\n--- script ---\n${script}`);
    return result;
  }

  for (const script of scripts) {
    test(JSON.stringify(script), () => {
      expect(expectFaithful(script, false).ran.length).toBeGreaterThan(0);
    });
  }

  for (const script of hiding) {
    test(`hiding ${JSON.stringify(script)}`, () => {
      expect(expectFaithful(script, true).ran.length).toBeGreaterThan(0);
    });
  }

  test(
    'generated scripts',
    () => {
      fc.assert(
        fc.property(seenScript, (script) => {
          expectFaithful(script, true);
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
          expectFaithful(script, true, { seconds: mutantSeconds, bounded: true });
        }),
        { numRuns: mutationRuns, includeErrorInReport: true },
      );
    },
    { timeout: Math.max(5_000, mutationRuns * (mutantSeconds + 1) * 1000) },
  );
});

/** What a run did: each stub's argv and the directory it ran in (from `work`, `/`-separated), and the files written. */
interface Run {
  ran: { argv: string[]; cwd: string }[];
  written: string[];
}

/** A path of the analysis's, from `work`: `~` is the run's home, beside it. */
const fromWork = (path: string) => (/^~(\/|$)/.test(path) ? `../home${path.slice(1)}` : path);

/** Where an invocation runs, from `work`; `undefined` when the analysis doesn't know. */
const place = (invocation: Invocation) => (invocation.cwd === undefined ? undefined : resolvePath(fromWork(invocation.cwd), '.'));

/** The file a write lands on, from `work`; `undefined` when it may be any. */
function target(invocation: Invocation, write: Arg): string | undefined {
  if (write.kind === 'dynamic' || invocation.cwd === undefined) return undefined;
  return resolvePath(fromWork(invocation.cwd), fromWork(write.value));
}
