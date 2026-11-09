import * as fc from 'fast-check';

/**
 * Wrapped commands: real wrapper programs (`env`, `timeout`, `xargs`, `find -exec`…) around the logging stubs, with
 * their options spelled every way getopt reads them (clustered, attached, `=`, abbreviated, after `--`), nested a few
 * deep. What the wrapper finally runs checks its spec: a missed option that takes a value moves where the command starts.
 */

/** What runs inside: a stub, with words a wrapper may take for options, or fill in (`{}`). */
const leaf = fc
  .tuple(fc.constantFrom('cat', 'ls', 'sort', 'grep'), fc.array(fc.constantFrom('a', '-b', '{}', '--', '-n1'), { maxLength: 2 }))
  .map(([program, args]) => [program, ...args].join(' '));

type Wrap = (inner: string) => string;
const some = (options: string[], min = 0) => fc.shuffledSubarray(options, { minLength: min, maxLength: 3 });
const around = (head: fc.Arbitrary<string>): fc.Arbitrary<Wrap> => head.map((words) => (inner: string) => `${words} ${inner}`);

/** Each wrapper by the program it runs: the words before the command it starts. */
const wrappers: Record<string, fc.Arbitrary<Wrap>> = {
  env: fc.oneof(
    around(
      fc
        .tuple(
          some([
            '-i',
            '-iv',
            '-u X',
            '-uX',
            '--unset=X',
            '--uns X',
            '-v',
            '--debug',
            '-C bin',
            '--chdir=bin',
            '--ch bin',
            '--default-signal',
            '--default-signal=INT',
            '--ignore-signal=INT',
            '--',
          ]),
          fc.boolean(),
          fc.subarray(['X=1', 'Y=2']),
        )
        .map(([options, dash, assignments]) => ['env', ...options, ...(dash ? ['-'] : []), ...assignments].join(' ')),
    ),
    // A string env splits into the command line itself.
    fc.constantFrom('-S', '--split-string=', '--split ', '-S').map((option) => (inner: string) => `env ${option}"${inner}"`),
  ),
  nice: around(some(['-n 1', '-n1', '--adjustment=1', '--adj 1', '--adjustment 2', '-1', '--'], 0).map((o) => ['nice', ...o].join(' '))),
  nohup: around(fc.constantFrom('nohup', 'nohup --')),
  timeout: around(
    fc
      .tuple(
        some([
          '-s KILL',
          '-sTERM',
          '--signal=TERM',
          '--sig KILL',
          '-k 1',
          '-k1',
          '--kill-after=1',
          '--kill 1',
          '--preserve-status',
          '--foreground',
          '-v',
          '--',
        ]),
        fc.constantFrom('5', '5s', '1m'),
      )
      .map(([options, duration]) => ['timeout', ...options, duration].join(' ')),
  ),
  stdbuf: around(some(['-oL', '-o L', '--output=L', '--out L', '-e0', '-i0'], 1).map((o) => ['stdbuf', ...o].join(' '))),
  xargs: around(
    some([
      '-r',
      '-n 1',
      '-n1',
      '--max-args=1',
      '--max-a 1',
      '-L 1',
      '-l',
      '-I {}',
      '-I{}',
      '-i',
      '-i{}',
      '--replace',
      '-E X',
      '-e',
      '-eX',
      '-t',
      '-s 200',
      '-P 1',
      '--process-slot-var=V',
      '-0',
      '-d,',
      '--',
    ]).map((o) => ['xargs', ...o].join(' ')),
  ),
  // `{}` must end a `+` command; a misplaced one is find's error, and nothing runs.
  find: fc
    .tuple(
      fc.constantFrom('', '-H ', '-L '),
      fc.constantFrom('bin', '.', 'bin/cat'),
      fc.constantFrom('-maxdepth 0', '-name cat', '-name nope -o -maxdepth 0'),
      fc.constantFrom('-exec', '-execdir'),
      fc.constantFrom('\\;', "';'", '+'),
    )
    .map(
      ([before, path, test, action, end]) =>
        (inner: string) =>
          `find ${before}${path} ${test} ${action} ${inner} {} ${end}`,
    ),
  setsid: around(fc.constantFrom('setsid -w', 'setsid --wait', 'setsid -w --')),
  // A flock inside another on the same file waits forever, so each takes a file named after what it wraps, which is
  // longer for each one further out.
  flock: fc
    .constantFrom('flock', 'flock -n', 'flock -s', 'flock -w 1', 'flock --shared')
    .map((words) => (inner: string) => `${words} lk${inner.length} ${inner}`),
  ionice: around(fc.constantFrom('ionice -c 3', 'ionice -c3', 'ionice --class 3', 'ionice --cl 3', 'ionice -t -c 2 -n 7')),
  taskset: around(fc.constantFrom('taskset 1', 'taskset -a 1', 'taskset -c 0', 'taskset --cpu-list 0')),
};

/** Wrapped commands the generator found the specs wrong on, with the programs they need. */
export const wrappedScripts: [script: string, needs: string[]][] = [
  ['env --uns X cat a; nice --adj 1 ls b; timeout --sig KILL 5 sort c', ['env', 'nice', 'timeout']],
  ['env - X=1 cat a; env -- --x=1 ls b', ['env']],
  ['env -S"env -Snice cat" a; env -S"sort -n" b', ['env', 'nice']],
  ["xargs -I{} cat {} <<< 'p q'; xargs --replace sort x{} <<< 'r'", ['xargs']],
  ['find . -name cat -execdir ls {} \\;', ['find']],
  [`env -i PATH="$PATH" timeout 5 xargs cat <<< 'p q'`, ['env', 'timeout', 'xargs']],
];

/** Programs that run the command they're given, which the harness puts in place of logging stubs. */
export const wrapperNames = Object.keys(wrappers);

/**
 * Lines of wrapped commands, with input for `xargs`, over the wrappers this machine has. Every line is valid Bash; a
 * wrapper may still refuse its arguments, and then runs nothing.
 */
export function wrappedScript(available: readonly string[]): fc.Arbitrary<string> {
  const wraps = fc.oneof(...available.map((name) => wrappers[name]!));
  const line = fc
    .tuple(fc.array(wraps, { minLength: 1, maxLength: 3 }), leaf)
    .map(([outer, inner]) => `${outer.reduceRight((code, wrap) => wrap(code), inner)} <<< 'p q'`);
  return fc.array(line, { minLength: 1, maxLength: 2 }).map((lines) => lines.join('\n'));
}
