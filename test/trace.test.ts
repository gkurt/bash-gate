import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze } from '#src/index.ts';
import { buildSupervisor, run, type RunOptions } from '#src/trace/index.ts';
import { scripts } from './scripts.ts';

/**
 * Layer 3 against the kernel: every exec in the process tree is seen, not only programs on a stub `PATH`, so this is
 * the stricter oracle for S1. Real programs run, inside a temporary directory.
 */
const supported = process.platform === 'linux' && process.arch === 'x64' && spawnSync('cc', ['--version']).status === 0;

describe.skipIf(!supported)('trace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bash-gate-trace-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const supervisor = supported ? buildSupervisor(join(dir, 'cache')) : '';
  const work = join(dir, 'work');
  const options = (more: RunOptions = {}): RunOptions => ({ supervisor, cwd: work, timeout: 10_000, ...more });
  const fresh = () => {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work);
  };
  fresh();
  const shown = (execs: { argv: string[] }[]) => execs.map((exec) => exec.argv.join(' '));

  for (const script of scripts) {
    test(`covers ${JSON.stringify(script)}`, async () => {
      fresh();
      const result = await run(script, options({ mode: 'trace', env: { PATH: '/usr/bin:/bin', FUNCNEST: '8' } }));
      expect(result.timedOut).toBe(false);
      expect(result.execs.length).toBeGreaterThan(0);
      expect(shown(result.execs.filter((exec) => exec.covered === false))).toEqual([]);
    });
  }

  test('enforce refuses what the analysis did not predict, before it runs', async () => {
    const result = await run('echo before; cat /etc/hostname; echo after', options({ analysis: analyze('echo before; echo after') }));
    expect(result.stdout).toBe('before\nafter\n');
    expect(result.stderr).toContain('Operation not permitted');
    expect(result.execs.map(({ argv, covered, refused }) => [argv.join(' '), covered, refused])).toEqual([
      ['cat /etc/hostname', false, true],
    ]);
  });

  test('trace lets it run and reports it', async () => {
    const result = await run('cat /etc/hostname', options({ mode: 'trace', analysis: analyze('true') }));
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.execs.map(({ covered, refused }) => [covered, refused])).toEqual([[false, false]]);
  });

  test('what wrappers start is checked under them', async () => {
    const script = "printf 'a\\n' | xargs echo x; find /etc/hostname -exec cat {} \\;; timeout 5 sh -c 'uname -s'; env A=1 nice true";
    const result = await run(script, options());
    expect(result.code).toBe(0);
    const ran = result.execs.filter((exec) => !exec.refused);
    expect(new Set(ran.map((exec) => `${exec.argv[0]} ${JSON.stringify(exec.via)} ${exec.covered}`))).toEqual(
      new Set([
        'xargs [] true',
        'echo ["xargs"] true',
        'find [] true',
        'cat ["find"] true',
        'timeout [] true',
        'sh ["timeout"] true',
        'uname ["timeout"] true',
        'env [] true',
        'nice ["env"] true',
        'true ["env","nice"] true',
      ]),
    );
  });

  test('a wrapper starting what the analysis did not predict is refused', async () => {
    const analysis = analyze('env true');
    const inner = analysis.invocations.find((invocation) => invocation.program === 'true')!;
    inner.program = 'false';
    const result = await run('env true', options({ analysis }));
    expect(result.code).not.toBe(0);
    expect(result.execs.map(({ argv, via, refused }) => [argv[0], via, refused])).toContainEqual(['true', ['env'], true]);
  });

  test("a program's own children aren't checked", async () => {
    fresh();
    writeFileSync(join(work, 'build.sh'), 'cat /etc/hostname\n');
    const result = await run('bash build.sh', options());
    expect(result.code).toBe(0);
    expect(result.execs.map(({ argv, via, covered, refused }) => [argv.join(' '), via, covered, refused])).toEqual([
      ['bash build.sh', [], true, false],
      ['cat /etc/hostname', null, null, false],
    ]);
  });

  test('exec replaces the shell and is still checked', async () => {
    const result = await run('exec cat /etc/hostname', options({ analysis: analyze('exec ls') }));
    expect(result.code).toBe(126);
    expect(result.execs.map(({ refused }) => refused)).toEqual([true]);
  });

  test('the timeout kills the whole tree', async () => {
    const result = await run('sleep 5 & sleep 5', options({ timeout: 300 }));
    expect(result.timedOut).toBe(true);
  });
});
