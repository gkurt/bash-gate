import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fc from 'fast-check';
import { analyze } from '#src/index.ts';
import { buildSupervisor, run, type RunOptions } from '#src/trace/index.ts';
import { generatedScript } from './generated.ts';
import { hiding, scripts } from './scripts.ts';

/**
 * Layer 3 against the kernel: every exec in the process tree is seen, not only programs on a stub `PATH`, so this is
 * the stricter oracle for S1. Real programs run, inside a temporary directory.
 */
const supported = process.platform === 'linux' && process.arch === 'x64' && spawnSync('cc', ['--version']).status === 0;
const runs = Number(process.env.TRACE_RUNS ?? 50);
const python = supported && spawnSync('python3', ['--version']).status === 0;
/** Yama's ptrace_scope: from 1, a process may write only its descendants' memory. */
const ptraceScope = (() => {
  try {
    return Number(readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8'));
  } catch {
    return 0;
  }
})();

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
  const traced = (script: string, funcnest = '8') => {
    fresh();
    return run(script, options({ mode: 'trace', env: { PATH: '/usr/bin:/bin', FUNCNEST: funcnest } }));
  };

  for (const script of [...scripts, ...hiding]) {
    test(`covers ${JSON.stringify(script)}`, async () => {
      const result = await traced(script);
      expect(result.timedOut).toBe(false);
      expect(result.execs.length).toBeGreaterThan(0);
      expect(shown(result.execs.filter((exec) => exec.covered === false))).toEqual([]);
    });
  }

  test(
    'covers generated scripts',
    async () => {
      await fc.assert(
        fc.asyncProperty(generatedScript, async (script) => {
          // A function calling itself twice per loop pass forks thousands of processes by FUNCNEST=8, each stopped by
          // the supervisor. A lower limit only makes Bash run less than the analysis predicts.
          const result = await traced(script, '4');
          if (result.timedOut) throw new Error(`Timed out:\n${script}`);
          const misses = shown(result.execs.filter((exec) => exec.covered === false));
          if (misses.length > 0) throw new Error(`Ran but not predicted: ${misses.join(' | ')}\n--- script ---\n${script}`);
        }),
        { numRuns: runs },
      );
    },
    { timeout: Math.max(5_000, runs * 1_000) },
  );

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

  test('nothing a command started outlives the run, daemons included', async () => {
    fresh();
    const script = "setsid -f sh -c 'sleep 0.3; echo > setsid'; nohup sh -c 'sleep 0.3; echo > nohup' >/dev/null 2>&1 &";
    const result = await run(script, options());
    expect(result.code).toBe(0);
    expect(readdirSync(work).sort()).toEqual(['nohup', 'setsid']);
  });

  test('no process in the tree holds CAP_SYS_PTRACE, root included', async () => {
    const result = await run('cat /proc/self/status', options());
    const sets = new Map([...result.stdout.matchAll(/^(Cap\w+):\s*([0-9a-f]+)$/gm)].map(([, name, bits]) => [name!, BigInt(`0x${bits}`)]));
    const ptrace = 1n << 19n;
    // Only a process with CAP_SETPCAP can drop it from the bounding set; no_new_privs keeps anyone else from gaining it.
    const names = ['CapInh', 'CapPrm', 'CapEff', 'CapAmb', ...(process.getuid?.() === 0 ? ['CapBnd'] : [])];
    for (const name of names) expect([name, sets.get(name)! & ptrace]).toEqual([name, 0n]);
  });

  test.skipIf(ptraceScope < 1)("a process can't write its parent's memory", async () => {
    // Not the last command, so Bash forks for it and `$$` is its parent.
    const result = await run('dd if=/dev/null of=/proc/$$/mem conv=notrunc; :', options({ mode: 'trace' }));
    expect(result.stderr).toContain('Permission denied');
  });

  test.skipIf(!python)("an exec's arguments can't change after the check", async () => {
    fresh();
    // Python, which the shell became, flips the path each child of its subshell is about to exec from true to date and
    // back, as fast as it can. Without the tree stopped, the check sometimes reads true and the kernel date.
    writeFileSync(
      join(work, 'flip.py'),
      `import os
me = os.getpid()
def children(pid):
    try: return [int(c) for c in open(f'/proc/{pid}/task/{pid}/children').read().split()]
    except OSError: return []
while not children(me): pass
sub = children(me)[0]
seen = set()
while os.waitpid(sub, os.WNOHANG) == (0, 0):
    for pid in set(children(sub)) - seen:
        seen.add(pid)
        try:
            mem = os.open(f'/proc/{pid}/mem', os.O_RDWR)
            while (call := open(f'/proc/{pid}/syscall').read().split())[0] != '59': pass
            path = int(call[1], 16)
            if os.pread(mem, 14, path) == b'/usr/bin/true\\0':
                for _ in range(20000):
                    os.pwrite(mem, b'date', path + 9)
                    os.pwrite(mem, b'true', path + 9)
            os.close(mem)
        except (OSError, IndexError):
            pass
`,
    );
    const script = '(sleep 0.3; for i in $(seq 30); do /usr/bin/true; sleep 0.02; done) & exec python3 flip.py';
    const result = await run(script, options({ timeout: 30_000 }));
    expect(result.timedOut).toBe(false);
    expect(result.execs.filter((exec) => exec.path === '/usr/bin/true' && !exec.refused).length).toBeGreaterThan(0);
    // What date would print. A date the check read was refused.
    expect(result.stdout).toBe('');
  });

  test.skipIf(!python)('a process started with CLONE_UNTRACED, which nothing would stop or wait for, is refused', async () => {
    const clone = 'import ctypes, os; pid = ctypes.CDLL(None, use_errno=True).syscall(56, 0x00800000 | 17, 0, 0, 0, 0)';
    const result = await run(`python3 -c '${clone}; print(os.strerror(ctypes.get_errno()) if pid < 0 else pid)'`, options());
    expect(result.stdout).toBe('Operation not permitted\n');
  });

  test.skipIf(!python)('threads, vfork and an exec from a thread still run', async () => {
    const code = [
      'import os, subprocess, threading',
      't = threading.Thread(target=print, args=("thread",))',
      't.start()',
      't.join()',
      'print(subprocess.run(["echo", "vfork"], capture_output=True, text=True).stdout, end="")',
      'threading.Thread(target=os.execv, args=("/bin/echo", ["echo", "exec"])).start()',
      'threading.Event().wait()',
    ].join('\n');
    const result = await run(`python3 -u -c '${code}'`, options());
    expect(result.stdout).toBe('thread\nvfork\nexec\n');
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
