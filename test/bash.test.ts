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
import { generatedScript } from './generated.ts';
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

const runs = Number(process.env.BASH_RUNS ?? 100);

describe.skipIf(!compatibleBash)('against bash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bash-gate-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // One log per process: substitutions run alongside the command, and their writes would interleave. Each ends with
  // \x1e, so a log still being written isn't read as a shorter argv.
  const stub = `#!/bin/sh\n{ printf '%s' "\${0##*/}"; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\036'; } > "$BASH_GATE_LOGS/$$"\n`;
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
    const ran = finished(logs).map((log) => log.split('\x1f'));
    rmSync(logs, { recursive: true, force: true });
    return ran;
  }

  /** The logs, once each is complete: a process substitution may still be writing after Bash exits. */
  function finished(logs: string): string[] {
    for (const deadline = Date.now() + 5_000; ;) {
      const texts = readdirSync(logs).map((file) => readFileSync(join(logs, file), 'utf8'));
      if (texts.every((text) => text.endsWith('\x1e'))) return texts.map((text) => text.slice(0, -1));
      if (Date.now() > deadline) throw new Error(`A stub never finished its log: ${JSON.stringify(texts)}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
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
