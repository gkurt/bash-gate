/**
 * Layer 3: runs a command line in Bash under a supervisor that stops every exec in its process tree. Each exec the
 * shell (or a wrapper the analysis followed, such as `xargs` or `env`) makes is checked against the analysis: in
 * `enforce` mode one it doesn't cover is refused with EPERM before it runs, so a gap in S1 is a failed command rather
 * than an escape; in `trace` mode it runs and is reported. x86_64 Linux only, with a C compiler for the supervisor.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { constants, homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { analyze, type Environment } from '#src/analyze.ts';
import { covers, predicting, wrappers } from '#src/cover.ts';
import { specFor } from '#src/specs.ts';
import type { Analysis, Invocation } from '#src/types.ts';

export interface RunOptions extends Environment {
  /** `enforce` (the default) refuses an exec the analysis doesn't cover; `trace` lets it run and reports it. */
  mode?: 'enforce' | 'trace';
  /** The analysis to hold the run to. By default `analyze(source, options)`, with `cwd` and `env` as the run's. */
  analysis?: Analysis;
  /** The directory the command runs in; by default the current one. */
  cwd?: string;
  /** The whole environment of the run, as in the threat model's clean Bash; by default only a `PATH` of system directories. */
  env?: Record<string, string>;
  /** What the command reads on standard input; nothing by default. */
  input?: string;
  /** Milliseconds before the whole process tree is killed. */
  timeout?: number;
  /** A supervisor binary from `buildSupervisor`; by default it's built on first use. */
  supervisor?: string;
}

export interface Exec {
  pid: number;
  /** The file it ran, as given to `execve` (resolved against the directory for `execveat`). */
  path: string;
  /** Its arguments, the first as the caller gave it. */
  argv: string[];
  /**
   * The wrappers it runs under, outermost first, shells left out. `null` when a program the analysis doesn't follow
   * inside (`git`, `make`, `python3`) started it: what that program runs is its own behaviour, which isn't checked.
   */
  via: string[] | null;
  /** Whether the analysis covers it; `null` when it isn't checked. */
  covered: boolean | null;
  /** Whether it was refused: not covered, or made by a process with several threads, which could change its arguments after the check. */
  refused: boolean;
}

export interface RunResult {
  /** The shell's exit code, or `null` when a signal ended it. */
  code: number | null;
  /** The signal that ended the shell, by name (`SIGKILL`). */
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Every exec in the process tree, in order, the shell's own first one aside. */
  execs: Exec[];
}

/** The shells whose code the analysis walks: what they start is checked like what the script starts. */
const shells = new Set(['bash', 'sh']);
const systemPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * Runs `source` with `bash --noprofile --norc -c` under the supervisor, and resolves once every process it started has
 * exited.
 */
export async function run(source: string, options: RunOptions = {}): Promise<RunResult> {
  const { mode = 'enforce', input, timeout } = options;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? { PATH: systemPath };
  const analysis = options.analysis ?? analyze(source, { ...options, cwd, env });
  const supervisor = options.supervisor ?? buildSupervisor();

  const directory = mkdtempSync(join(tmpdir(), 'bash-gate-'));
  const address = join(directory, 'socket');
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(address, resolve));
    const session = new Session(analysis, mode);
    server.on('connection', (socket) => (session.attached ? socket.destroy() : session.attach(socket)));
    const child = spawn(supervisor, [address, 'bash', '--noprofile', '--norc', '-c', source], {
      cwd,
      env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    child.stdin?.end(input);
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    let timedOut = false;
    const timer = timeout === undefined ? undefined : setTimeout(() => ((timedOut = true), child.kill('SIGKILL')), timeout);

    const exited = await new Promise<number | null>((resolve, reject) => child.once('error', reject).once('close', resolve));
    clearTimeout(timer);
    // Once the supervisor's connection, if it made one, has delivered everything.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!timedOut && !session.end) throw new Error(`bash-gate supervisor failed: ${session.failure ?? `exit ${exited}`}\n${stderr}`);
    const [code, signal] = session.end ?? [-1, 0];
    return {
      code: code < 0 ? null : code,
      signal: signal === 0 ? null : signalName(signal),
      timedOut,
      stdout,
      stderr,
      execs: session.execs,
    };
  } finally {
    if (server.listening) server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Where a process stands: the wrappers it runs under while it's checked, `null` once it runs code the analysis doesn't follow. */
type Role = string[] | null;

/** One supervisor's records, and the answers to its questions. */
class Session {
  readonly execs: Exec[] = [];
  end?: [code: number, signal: number];
  failure?: string;
  attached = false;
  private readonly roles = new Map<number, Role>();
  /** What a process becomes if the exec it asked about happens. */
  private readonly pending = new Map<number, Role>();
  private fields: string[] = [];
  private partial = Buffer.alloc(0);

  private readonly analysis: Analysis;
  private readonly mode: 'enforce' | 'trace';

  constructor(analysis: Analysis, mode: 'enforce' | 'trace') {
    this.analysis = analysis;
    this.mode = mode;
  }

  attach(socket: Socket): void {
    this.attached = true;
    socket.on('data', (chunk: Buffer) => this.receive(chunk, socket));
    socket.on('error', (error) => (this.failure ??= error.message));
  }

  private receive(chunk: Buffer, socket: Socket): void {
    let data = Buffer.concat([this.partial, chunk]);
    for (let end = data.indexOf(0); end >= 0; end = data.indexOf(0)) {
      this.fields.push(data.subarray(0, end).toString('utf8'));
      data = data.subarray(end + 1);
    }
    this.partial = data;
    for (let size = this.complete(); size > 0; size = this.complete()) {
      const [kind = '', ...fields] = this.fields.splice(0, size);
      this.record(kind, fields, socket);
    }
  }

  /** How many fields the first record has, when all of them are here. */
  private complete(): number {
    const [kind] = this.fields;
    const size = kind === 'X' ? 5 + Number(this.fields[4] ?? Infinity) : kind === 'R' || kind === '!' ? 2 : 3;
    return kind !== undefined && this.fields.length >= size ? size : 0;
  }

  private record(kind: string, fields: string[], socket: Socket): void {
    const [a = '', b = ''] = fields;
    switch (kind) {
      case 'R':
        this.roles.set(Number(a), []);
        return;
      case 'F':
        this.roles.set(Number(b), this.role(Number(a)));
        return;
      case 'E': {
        const former = Number(b);
        this.roles.set(Number(a), this.pending.has(former) ? this.pending.get(former)! : []);
        this.pending.delete(former);
        return;
      }
      case 'Z':
        this.end = [Number(a), Number(b)];
        return;
      case '!':
        this.failure = a;
        return;
      case 'X':
        socket.write(this.exec(Number(a), Number(b), fields[2]!, fields.slice(4)));
        return;
      default:
        this.failure = `unknown record ${kind}`;
    }
  }

  /** A process the supervisor didn't report is checked from the top: stricter than anything it could have been. */
  private role(pid: number): Role {
    return this.roles.has(pid) ? this.roles.get(pid)! : [];
  }

  private exec(pid: number, threads: number, path: string, argv: string[]): 'y' | 'n' {
    const via = this.role(pid);
    if (via === null) {
      this.execs.push({ pid, path, argv, via, covered: null, refused: false });
      this.pending.set(pid, null);
      return 'y';
    }
    const { covered, next } = judge(this.analysis, via, [basename(path), ...argv.slice(1)]);
    const refused = this.mode === 'enforce' && (!covered || threads > 1);
    this.execs.push({ pid, path, argv, via, covered, refused });
    if (!refused) this.pending.set(pid, next);
    return refused ? 'n' : 'y';
  }
}

/** Whether the analysis covers an exec by a checked process, and what the process is after it. */
function judge(analysis: Analysis, via: string[], argv: string[]): { covered: boolean; next: Role } {
  const program = argv[0]!;
  const found = predicting(analysis, argv, via);
  if (found.length > 0) return { covered: true, next: after(analysis, via, program, found) };
  // A wrapper that runs its command through a shell (`watch`, `flock -c`): the analysis walked that code under it.
  const wrapper = via.at(-1);
  if (
    shells.has(program) &&
    wrapper !== undefined &&
    analysis.invocations.some((invocation) => startsWith(wrappers(invocation), via) && invocation.nesting.includes(`${wrapper} -c`))
  )
    return { covered: true, next: via };

  return { covered: covers(analysis, argv, via), next: null };
}

/**
 * A shell running code the analysis walked stays checked; one running a file or its input doesn't. A wrapper whose
 * commands the analysis predicts is checked with itself added, unless it also runs helpers of its own (a program with
 * subcommands, such as `git`) or runs them elsewhere (`ssh`). Anything else is its own business.
 */
function after(analysis: Analysis, via: string[], program: string, found: Invocation[]): Role {
  if (shells.has(program)) {
    const unwalked = found.some((invocation) => invocation.effects.includes('exec:file') || invocation.effects.includes('exec:arbitrary'));
    return unwalked ? null : via;
  }
  const inner = [...via, program];
  const under = analysis.invocations.filter((invocation) => startsWith(wrappers(invocation), inner));
  if (under.length === 0 || specFor(program)?.subcommands) return null;
  if (under.every((invocation) => invocation.nesting.includes(`${program} (remote)`))) return null;
  return inner;
}

function startsWith(list: string[], prefix: string[]): boolean {
  return prefix.every((value, i) => list[i] === value);
}

function signalName(signal: number): string | null {
  return Object.entries(constants.signals).find(([, value]) => value === signal)?.[0] ?? null;
}

/**
 * Builds the supervisor with the system's C compiler (`$CC`, else `cc`) into `directory`, once per version of its
 * source, and returns its path. `run` calls it when it isn't given one.
 */
export function buildSupervisor(directory = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'bash-gate')): string {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('bash-gate/trace runs on x86_64 Linux only');
  const source = readFileSync(new URL('./supervisor.c', import.meta.url), 'utf8');
  const path = join(directory, `supervisor-${createHash('sha256').update(source).digest('hex').slice(0, 16)}`);
  if (existsSync(path)) return path;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const building = `${path}.${process.pid}`;
  execFileSync(process.env.CC ?? 'cc', ['-O2', '-x', 'c', '-o', building, '-'], { input: source, stdio: ['pipe', 'ignore', 'pipe'] });
  renameSync(building, path);
  return path;
}
