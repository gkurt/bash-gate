import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, type Invocation } from '../src/index.ts';

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
  'cat $(ls x) <(sort y)',
  'for f in a b; do cat "$f"; done',
  'if true; then cat a; else ls b; fi',
  'cat <<EOF\n$(ls x)\nEOF',
  '(( a[$(ls q)] = 1 ))',
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
  "shopt -s expand_aliases\nif [ -n \"$x\" ]; then alias rm=cat; fi\nrm a",
  "/bin/sh -c 'alias ls=cat\nls a'",
  "/bin/bash --posix -c 'alias ls=cat\nls a'; /bin/bash -O expand_aliases -c 'alias rm=cat\nrm b'",
  'set -o posix\nalias ls=cat\nls a',
  "PS4='+$(ls ps4) '; set -x; cat a",
];

const stubs = ['rm', 'ls', 'cat', 'sort', 'git', 'grep', 'echo', 'env', 'sudo', 'xargs'];
const bash = Bun.which('bash');

/** Whether the invocation predicts this run: the program, and every static argument where it stands. */
function covers(invocation: Invocation, argv: string[]): boolean {
  // A command name only known at run time may be any program.
  if (invocation.program === null) return true;
  if (invocation.program !== argv[0]) return false;
  const predicted = invocation.argv.slice(1);
  if (invocation.open || predicted.some((arg) => arg.kind === 'dynamic' && arg.split)) return true;
  const args = argv.slice(1);
  return predicted.length === args.length && predicted.every((arg, i) => arg.kind === 'dynamic' || arg.value === args[i]);
}

describe.skipIf(!bash)('against bash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bash-gate-'));
  const bin = join(dir, 'bin');
  const logs = join(dir, 'logs');
  mkdirSync(bin);
  // One log per process: substitutions run alongside the command, and their writes would interleave.
  const stub = `#!/bin/sh\n{ printf '%s' "\${0##*/}"; for a in "$@"; do printf '\\037%s' "$a"; done; } > "$BASH_GATE_LOGS/$$"\n`;
  for (const name of stubs) {
    writeFileSync(join(bin, name), stub);
    chmodSync(join(bin, name), 0o755);
  }
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  for (const script of scripts) {
    test(JSON.stringify(script), () => {
      rmSync(logs, { recursive: true, force: true });
      mkdirSync(logs);
      // From a file: Git Bash's runtime expands braces and globs in the arguments a Windows process gives it.
      writeFileSync(join(dir, 'script.sh'), script);
      Bun.spawnSync([bash!, '--noprofile', '--norc', 'script.sh'], { cwd: dir, env: { PATH: bin, BASH_GATE_LOGS: logs } });
      const ran = readdirSync(logs).map((file) => readFileSync(join(logs, file), 'utf8').split('\x1f'));
      expect(ran.length).toBeGreaterThan(0);
      const predicted = analyze(script).invocations.filter((invocation) => invocation.kind === 'external' && invocation.via.every((program) => program === 'bash' || program === 'sh'));
      const missed = ran.filter((argv) => !predicted.some((invocation) => covers(invocation, argv)));
      expect(missed.map((argv) => argv.join(' '))).toEqual([]);
    });
  }
});
