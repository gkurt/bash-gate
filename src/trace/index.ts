/**
 * Layer 3: runs a command line in Bash under a supervisor that stops every exec in its process tree. Each exec the
 * shell (or a wrapper the analysis followed, such as `xargs` or `env`) makes is checked against the analysis: in
 * `enforce` mode one it doesn't cover is refused with EPERM before it runs, so a gap in S1 is a failed command rather
 * than an escape; in `trace` mode it runs and is reported. x86_64 Linux only, with a C compiler for the supervisor.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { constants, homedir, tmpdir } from 'node:os';
import { basename, dirname, join, posix } from 'node:path';
import { analyze, type Environment } from '#src/analyze.ts';
import { covers, predicting, unseen, wrappers } from '#src/cover.ts';
import { followsLinks, isSystemPath, resolvePath } from '#src/paths.ts';
import { specFor } from '#src/specs.ts';
import type { Analysis, Arg, Invocation } from '#src/types.ts';

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
  /** Whether it was refused: in `enforce` mode, when the analysis doesn't cover it. */
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
    const session = new Session(analysis, mode, cwd, (env.PATH ?? '').split(':'));
    server.on('connection', (socket) => (session.attached ? socket.destroy() : session.attach(socket)));
    // The system's Bash, not one the run's PATH finds first (`./bash` through an empty entry).
    const child = spawn(supervisor, [address, systemBash(), '--noprofile', '--norc', '-c', source], {
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
  /** Where the run starts, and the directories its `PATH` names, where a program named without a path is found. */
  private readonly where: Where;

  constructor(analysis: Analysis, mode: 'enforce' | 'trace', cwd: string, path: string[]) {
    this.analysis = analysis;
    this.mode = mode;
    this.where = {
      cwd,
      search: new Set(path.filter((dir) => dir.startsWith('/')).map((dir) => posix.normalize(dir).replace(/(.)\/$/, '$1'))),
    };
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
    const size = kind === 'X' ? 4 + Number(this.fields[3] ?? Infinity) : kind === 'R' || kind === '!' ? 2 : 3;
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
        socket.write(this.exec(Number(a), b, fields.slice(3)));
        return;
      default:
        this.failure = `unknown record ${kind}`;
    }
  }

  /** A process the supervisor didn't report is checked from the top: stricter than anything it could have been. */
  private role(pid: number): Role {
    return this.roles.has(pid) ? this.roles.get(pid)! : [];
  }

  private exec(pid: number, path: string, argv: string[]): 'y' | 'n' {
    const via = this.role(pid);
    if (via === null) {
      this.execs.push({ pid, path, argv, via, covered: null, refused: false });
      this.pending.set(pid, null);
      return 'y';
    }
    const file = basename(path);
    const judged = judge(this.analysis, via, [file, ...argv.slice(1)], { path, ...this.where });
    // A program may act on the name it's started under (`exec -a pkill pgrep`): that name must be predicted too.
    const name = basename(argv[0] ?? file);
    // Bytes that aren't UTF-8 read as U+FFFD, which stands for any of them: only unseen code covers those.
    const garbled = [path, ...argv].some((text) => text.includes('�'));
    const named = name === file || judge(this.analysis, via, [name, ...argv.slice(1)]).covered;
    const covered = garbled ? this.analysis.findings.some((finding) => unseen.has(finding.kind)) : judged.covered && named;
    const { next } = judged;
    const refused = this.mode === 'enforce' && !covered;
    this.execs.push({ pid, path, argv, via, covered, refused });
    if (!refused) this.pending.set(pid, next);
    return refused ? 'n' : 'y';
  }
}

interface Where {
  cwd: string;
  search: Set<string>;
}

/**
 * Whether the analysis covers an exec by a checked process, and what the process is after it. With `at`, the file run
 * must be where the invocation says: the path it was given, or a directory of `PATH` for a name.
 */
function judge(analysis: Analysis, via: string[], argv: string[], at?: Where & { path: string }): { covered: boolean; next: Role } {
  const program = argv[0]!;
  const found = predicting(analysis, argv, via).filter(
    (invocation) => at === undefined || invocation.program === null || invocation.unplaced || placed(invocation, at),
  );
  if (found.length > 0) return { covered: true, next: after(analysis, via, program, found) };
  // A wrapper that runs its command through a shell (`watch`, `flock -c`): the analysis walked that code under it,
  // with the system's shell. Another file of that name (`SHELL=./bash flock -c`, a `PATH` set in the code) isn't it.
  // The code it runs is what the wrapper was given (`flock -c CODE`, or `watch`'s words joined), unless that's only known
  // at run time.
  const wrapper = via.at(-1);
  const system =
    at === undefined || (!followsLinks(at.path) && isSystemPath(at.path.startsWith('/') ? at.path : posix.join(at.cwd, at.path)));
  const code = argv[1] === '-c' ? argv[2] : undefined;
  // That invocation's own code, and nothing else of it: one only known at run time may be any.
  const given = (invocation: Invocation) =>
    invocation.program === wrapper &&
    startsWith(wrappers(invocation), via.slice(0, -1)) &&
    codeGiven(invocation).some((arg) => arg.kind === 'dynamic' || arg.value === code);
  if (
    shells.has(program) &&
    system &&
    wrapper !== undefined &&
    code !== undefined &&
    analysis.invocations.some((invocation) => startsWith(wrappers(invocation), via) && invocation.nesting.includes(`${wrapper} -c`)) &&
    analysis.invocations.some(given)
  )
    return { covered: true, next: via };

  // Placed apart, only a finding that leaves code unseen accounts for it.
  const covered = at === undefined ? covers(analysis, argv, via) : analysis.findings.some((finding) => unseen.has(finding.kind));
  return { covered, next: null };
}

/**
 * The shell code a wrapper invocation was given: `--command` (`flock -c`, `script -c`), the word after `-c` in
 * `flock FILE -c CODE`, or `watch`'s command words joined. A word only known at run time stands for any code.
 */
function codeGiven(invocation: Invocation): Arg[] {
  const options = (invocation.options['--command'] ?? []).filter((value) => value !== true);
  const after = invocation.argv.findIndex((arg, i) => i > 0 && arg.kind === 'static' && (arg.value === '-c' || arg.value === '--command'));
  const following = after === -1 ? undefined : invocation.argv[after + 1];
  const words = joined(invocation.positionals);
  const watched: Arg[] =
    invocation.program !== 'watch' || invocation.positionals.length === 0
      ? []
      : [
          words === undefined
            ? { kind: 'dynamic', text: '', reason: 'variable', split: true, prefix: '' }
            : { kind: 'static', value: words },
        ];
  return [...options, ...(following ? [following] : []), ...watched];
}

/** Static words joined by spaces, as `watch` joins its command's; `undefined` when one is only known at run time. */
function joined(args: Arg[]): string | undefined {
  const words: string[] = [];
  for (const arg of args) {
    if (arg.kind !== 'static') return undefined;
    words.push(arg.value);
  }
  return words.join(' ');
}

/** The system's Bash, by its absolute path. */
function systemBash(): string {
  return ['/bin/bash', '/usr/bin/bash'].find((path) => existsSync(path)) ?? '/bin/bash';
}

/** Where `path` really is, or `undefined` when it isn't there. */
function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Whether the file an exec runs is the one the invocation names: its path, or the name found on `PATH`. */
function placed(invocation: Invocation, at: Where & { path: string }): boolean {
  // What the kernel ran isn't the text folded: `link/..` and `/proc/self/cwd/..` lead elsewhere.
  if (followsLinks(at.path)) return false;
  // The supervisor reads a relative path from where the process really is: the path is absolute here.
  const run = at.path.startsWith('/') ? posix.normalize(at.path) : posix.normalize(posix.join(at.cwd, at.path));
  if (invocation.path === undefined) return at.path.startsWith('/') && at.search.has(dirname(run));
  // A relative path from a directory only known at run time may be from any: it's the path as given there.
  if (invocation.cwd === undefined && !invocation.path.startsWith('/') && !invocation.path.startsWith('~'))
    return at.path.endsWith(`/${invocation.path}`);
  const cwd = invocation.cwd?.startsWith('/') ? invocation.cwd : posix.join(at.cwd, invocation.cwd ?? '.');
  const named = resolvePath(cwd, invocation.path, invocation.home);
  // The file each leads to: a relative path from a directory a symlink leads elsewhere isn't the one predicted.
  return named !== undefined && (named === run || (real(named) ?? named) === (real(run) ?? run));
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
