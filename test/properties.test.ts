import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';
import {
  analyze,
  check,
  evaluate,
  recommended,
  type Arg,
  type Decision,
  type Effect,
  type Invocation,
  type Policy,
  type Rule,
} from '#src/index.ts';
import { matchRule } from '#src/policy.ts';

/** Properties S2, S3 and S5 of THREAT_MODEL.md. */

const runs = Number(process.env.PROPERTY_RUNS ?? 2000);
const severity: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };
const effects: Effect[] = [
  'fs:read',
  'fs:write',
  'fs:delete',
  'network',
  'privilege',
  'exec:arbitrary',
  'exec:project',
  'exec:file',
  'exec:remote',
  'shell-state',
];

const staticArg = (value: string): Arg => ({ kind: 'static', value });
const dynamicArg = fc.record({
  kind: fc.constant('dynamic' as const),
  text: fc.constant('$x'),
  reason: fc.constantFrom('variable' as const, 'glob' as const, 'substitution' as const),
  split: fc.boolean(),
  prefix: fc.constantFrom('', '-', 'src/'),
});
const paths = ['/', '/etc', '/etc/passwd', 'src', 'src/a.ts', '../x', '..', '~', '~/x', '.', 'build', '-rf', 'origin', '+main'];
const arg: fc.Arbitrary<Arg> = fc.oneof(fc.constantFrom(...paths).map(staticArg), dynamicArg);
const optionNames = ['--force', '--recursive', '--delete', '--dry-run', '-x', '--user'];

const invocation: fc.Arbitrary<Invocation> = fc
  .record({
    program: fc.option(fc.constantFrom('rm', 'git', 'cat', 'curl', 'ls', 'cowsay', 'sudo'), { nil: null }),
    subcommands: fc.constantFrom([], ['push'], ['status'], ['branch']),
    options: fc.uniqueArray(fc.constantFrom(...optionNames)),
    positionals: fc.array(arg, { maxLength: 3 }),
    writes: fc.array(arg, { maxLength: 2 }),
    effects: fc.subarray(effects),
    maybeOptions: fc.boolean(),
    open: fc.boolean(),
    path: fc.constantFrom(undefined, '/bin/x', './x'),
    cwd: fc.constantFrom('.', '/', '/srv', undefined),
  })
  .map((r): Invocation => ({
    program: r.program,
    ...(r.path ? { path: r.path } : {}),
    kind: 'external',
    argv: [],
    subcommands: r.program === 'git' ? [...r.subcommands] : [],
    options: Object.fromEntries(r.options.map((name) => [name, [true]])),
    unknownOptions: [],
    positionals: r.positionals,
    maybeOptions: r.maybeOptions || r.open,
    open: r.open,
    specified: true,
    effects: r.effects,
    reads: [],
    writes: r.writes,
    cwd: r.cwd,
    via: [],
    nesting: [],
    shape: '',
    span: [0, 0],
    text: '',
  }));

const optional = <T>(arbitrary: fc.Arbitrary<T>) => fc.option(arbitrary, { nil: undefined });
const rule: fc.Arbitrary<Rule> = fc
  .record({
    decision: fc.constantFrom<Decision>('allow', 'ask', 'deny'),
    command: optional(fc.constantFrom('rm', 'git', 'git push', 'git status|branch', 'cat|ls', '*', 'curl', 'sudo')),
    options: optional(fc.subarray(['-f', '--force', '-r', '--recursive', '--delete', '--dry-run', '-x'], { minLength: 1 })),
    args: optional(fc.subarray(['/', '/*', '/**', 'src/**', '~', '~/**', '../**', '-rf', '+*'], { minLength: 1 })),
    writes: optional(fc.subarray(['/**', 'src/**', '~/**', '../**', 'build'], { minLength: 1 })),
    effects: optional(fc.subarray(effects, { minLength: 1 })),
  })
  .map((r) => Object.fromEntries(Object.entries(r).filter(([, value]) => value !== undefined)) as unknown as Rule);

const policy: fc.Arbitrary<Policy> = fc.record({
  rules: fc.array(rule, { maxLength: 6 }),
  default: fc.constantFrom<Decision>('allow', 'ask', 'deny'),
  strict: fc.boolean(),
});

const decide = (i: Invocation, p: Policy) => evaluate({ source: '', invocations: [i], findings: [], needs: [] }, p).decision;

/** Ways to make an invocation able to do more, without making anything known less. */
const additions: fc.Arbitrary<(i: Invocation) => Invocation> = fc.oneof(
  fc.constantFrom(...optionNames).map((name) => (i: Invocation): Invocation => ({ ...i, options: { ...i.options, [name]: [true] } })),
  arg.map((a) => (i: Invocation) => ({ ...i, positionals: [...i.positionals, a] })),
  arg.map((a) => (i: Invocation) => ({ ...i, writes: [...i.writes, a] })),
  fc.constantFrom(...effects).map((e) => (i: Invocation) => ({ ...i, effects: [...new Set([...i.effects, e])] })),
);

/** Ways to make something about an invocation unknown. */
const unknowns: fc.Arbitrary<(i: Invocation) => Invocation> = fc.oneof(
  dynamicArg.chain((a) =>
    fc.nat().map((n) => (i: Invocation) => ({
      ...i,
      positionals: i.positionals.map((p, k) => (k === n % Math.max(1, i.positionals.length) ? a : p)),
    })),
  ),
  dynamicArg.chain((a) =>
    fc.nat().map((n) => (i: Invocation) => ({ ...i, writes: i.writes.map((w, k) => (k === n % Math.max(1, i.writes.length) ? a : w)) })),
  ),
  fc.constant((i: Invocation) => ({ ...i, program: null })),
  fc.constant((i: Invocation) => ({ ...i, maybeOptions: true })),
  fc.constant((i: Invocation): Invocation => ({
    ...i,
    open: true,
    maybeOptions: true,
    positionals: [...i.positionals, { kind: 'dynamic', text: '…', reason: 'stdin', split: true, prefix: '' }],
  })),
  fc.constant((i: Invocation) => ({ ...i, path: './x' })),
);

describe('S2: the policy is monotone', () => {
  test('adding an option, positional, write or effect never lowers the decision', () => {
    fc.assert(
      fc.property(invocation, policy, additions, (i, p, add) => {
        expect(severity[decide(add(i), p)]).toBeGreaterThanOrEqual(severity[decide(i, p)]);
      }),
      { numRuns: runs },
    );
  });

  test('making something unknown never lowers the decision when strict, and only deny to ask otherwise', () => {
    fc.assert(
      fc.property(invocation, policy, unknowns, (i, p, hide) => {
        const before = severity[decide(i, p)];
        const after = severity[decide(hide(i), p)];
        expect(after).toBeGreaterThanOrEqual(p.strict ? before : Math.min(before, severity.ask));
      }),
      { numRuns: runs },
    );
  });
});

describe('S3: allow is earned', () => {
  test('an allowed invocation matches no deny or ask rule, not even maybe', () => {
    fc.assert(
      fc.property(invocation, policy, (i, p) => {
        if (decide(i, p) !== 'allow') return;
        for (const r of p.rules) if (r.decision !== 'allow') expect([r, matchRule(r, i)]).toEqual([r, 0]);
      }),
      { numRuns: runs },
    );
  });

  test('an allowed invocation was allowed by a rule that certainly matches, or by the default', () => {
    fc.assert(
      fc.property(invocation, policy, (i, p) => {
        if (decide(i, p) !== 'allow' || p.default === 'allow') return;
        expect(p.rules.some((r) => r.decision === 'allow' && matchRule(r, i) === 2)).toBe(true);
      }),
      { numRuns: runs },
    );
  });

  test('a finding is never allowed unless the policy says so', () => {
    fc.assert(
      fc.property(invocation, policy, (i, p) => {
        const finding = { kind: 'dynamic-command' as const, message: '', span: [0, 0] as [number, number] };
        expect(evaluate({ source: '', invocations: [i], findings: [finding], needs: [] }, { ...p, findings: {} }).decision).not.toBe(
          'allow',
        );
      }),
      { numRuns: runs },
    );
  });
});

/** Words a shell line is made of, to make syntax soup. */
const tokens = [
  'rm',
  '-rf',
  '/',
  'git',
  'push',
  '-f',
  'bash',
  '-c',
  'eval',
  'env',
  'sudo',
  'xargs',
  'find',
  '-exec',
  '{}',
  ';',
  '+',
  '&&',
  '||',
  '|',
  '&',
  ';;',
  '(',
  ')',
  '{',
  '}',
  '$(',
  '`',
  '"',
  "'",
  "$'",
  '\\',
  '\n',
  '$x',
  '${x',
  '}',
  '${x:-',
  '$((',
  '))',
  '[[',
  ']]',
  '<<',
  'EOF',
  '<(',
  '>(',
  '>',
  '<',
  '2>&1',
  '#',
  '!',
  'if',
  'then',
  'fi',
  'for',
  'in',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'f()',
  'alias',
  'shopt',
  '-s',
  'expand_aliases',
  'hash',
  '-p',
  'trap',
  '=',
  'x=',
  '*',
  '?',
  '[a]',
  '~',
  '..',
  '{a,b}',
  '{1..3}',
  'coproc',
  'select',
  'time',
  'while',
  'until',
];
const soup = fc
  .tuple(fc.array(fc.oneof(fc.constantFrom(...tokens), fc.string({ maxLength: 4 })), { maxLength: 24 }), fc.constantFrom(' ', '', '\t'))
  .map(([parts, separator]) => parts.join(separator));

describe('S5: fail closed', () => {
  test('arbitrary syntax soup never throws', () => {
    fc.assert(
      fc.property(soup, (source) => {
        const verdict = check(source, recommended);
        expect(['allow', 'ask', 'deny']).toContain(verdict.decision);
      }),
      { numRuns: runs },
    );
  });

  test('soup that fails to parse is never allowed', () => {
    fc.assert(
      fc.property(soup, (source) => {
        const { findings } = analyze(source);
        if (findings.some((f) => f.kind === 'parse-error'))
          expect(check(source, { rules: [{ decision: 'allow' }], default: 'allow' }).decision).not.toBe('allow');
      }),
      { numRuns: runs },
    );
  });
});
