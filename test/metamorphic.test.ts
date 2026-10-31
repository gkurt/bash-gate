import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';
import { ask, check, deny, recommended, type Decision, type Policy } from '#src/index.ts';

/** S4: equivalent rewrites must not make a denied or asked command easier to run. */
const runs = Number(process.env.METAMORPHIC_RUNS ?? process.env.PROPERTY_RUNS ?? 200);
/** Generated chains take about a millisecond each on a CI runner; Bun's default 5 s is too short for CI's run count. */
const timeout = Math.max(5_000, runs * 10);
const severity: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };
const permissive: Policy = {
  default: 'allow',
  rules: [
    deny('rm', { options: ['-r'], args: ['/', '/*'] }),
    deny('git push', { options: ['-f'] }),
    deny('git push', { args: ['+*'] }),
    ask('rm'),
    ask('git push'),
    ask('git branch', { options: ['-D'] }),
  ],
};
const policies = [recommended, { ...recommended, strict: true }, permissive, { ...permissive, strict: true }];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const seeds: { words: string[]; decision: Decision }[] = [
  { words: ['rm', '-rf', '/'], decision: 'deny' },
  { words: ['rm', '--recursive', '/etc'], decision: 'deny' },
  { words: ['git', 'push', '-f', 'origin', 'main'], decision: 'deny' },
  { words: ['git', 'push', 'origin', '+main'], decision: 'deny' },
  { words: ['rm', '-rf', './build'], decision: 'ask' },
  { words: ['git', 'push', 'origin', 'main'], decision: 'ask' },
  { words: ['git', 'branch', '-D', 'topic'], decision: 'ask' },
];

type Rewrite = { name: string; apply: (source: string) => string };
const wrappers: Rewrite[] = [
  { name: 'eval', apply: (s) => `eval ${quote(s)}` },
  { name: 'bash -c', apply: (s) => `bash -c ${quote(s)}` },
  { name: 'env', apply: (s) => `env bash -c ${quote(s)}` },
  { name: 'timeout', apply: (s) => `timeout 5 bash -c ${quote(s)}` },
  { name: 'command', apply: (s) => `command bash -c ${quote(s)}` },
  { name: 'function', apply: (s) => `s4function() { eval ${quote(s)}; }\ns4function` },
  { name: 'alias', apply: (s) => `shopt -s expand_aliases\nalias s4alias=${quote(`eval ${quote(s)}`)}\ns4alias` },
];

type Spelling = 'plain' | 'single' | 'double' | 'escaped' | 'concatenated' | 'ansi' | 'variable';
const spellings: Spelling[] = ['plain', 'single', 'double', 'escaped', 'concatenated', 'ansi', 'variable'];

/** Seed words deliberately contain only simple ASCII, so all these spellings represent exactly the same word. */
function spell(words: string[], choices: Spelling[]): string {
  const assignments: string[] = [];
  const rendered = words.map((word, i) => {
    switch (choices[i % choices.length]!) {
      case 'plain':
        return word;
      case 'single':
        return quote(word);
      case 'double':
        return `"${word}"`;
      case 'escaped':
        return `\\${word[0]}${word.slice(1)}`;
      case 'concatenated':
        return `${word[0]}""${word.slice(1)}`;
      case 'ansi':
        return `$'${word}'`;
      case 'variable':
        assignments.push(`s4word${i}=${quote(word)}`);
        return `"$s4word${i}"`;
    }
  });
  return [...assignments, rendered.join(' ')].join('; ');
}

function assertFloor(source: string, before: Decision, policy: Policy, context: string, hide = false): Decision {
  const verdict = check(source, policy);
  const floor = hide ? Math.min(severity[before], severity.ask) : severity[before];
  if (severity[verdict.decision] < floor)
    throw new Error(`${context}: ${before} -> ${verdict.decision}\n${source}\n${JSON.stringify(verdict.reasons)}`);

  return verdict.decision;
}

describe('S4: rewrite invariance', () => {
  for (const { words, decision } of seeds) {
    const original = words.join(' ');
    test(`${original}: spellings, braces, hash and individual wrappers`, () => {
      for (const policy of policies) {
        expect(check(original, policy).decision).toBe(decision);
        for (const spelling of spellings) assertFloor(spell(words, [spelling]), decision, policy, spelling);
        assertFloor(`{${words.join(',')}}`, decision, policy, 'brace expansion');
        assertFloor(`hash -p /bin/${words[0]} s4hashed\ns4hashed ${words.slice(1).join(' ')}`, decision, policy, 'hash -p');
        for (const wrapper of wrappers) assertFloor(wrapper.apply(original), decision, policy, wrapper.name);
      }
    });

    test(
      `${original}: chains of generated rewrites`,
      () => {
        fc.assert(
          fc.property(
            fc.array(fc.constantFrom(...spellings), { minLength: 1, maxLength: words.length }),
            fc.array(fc.constantFrom(...wrappers), { minLength: 1, maxLength: 3 }),
            (choices, chain) => {
              for (const policy of policies) {
                let source = spell(words, choices);
                let before = assertFloor(source, decision, policy, `spell ${choices.join(', ')}`);
                for (const wrapper of chain) {
                  source = wrapper.apply(source);
                  before = assertFloor(source, before, policy, wrapper.name);
                }
              }
            },
          ),
          { numRuns: runs },
        );
      },
      { timeout },
    );
  }

  test('hiding a word or code may lower deny to ask, but never to allow', () => {
    for (const { words, decision } of seeds) {
      for (const policy of policies) {
        for (const i of words.keys()) {
          const hidden = [...words];
          hidden[i] = `"$(printf %s ${quote(words[i]!)})"`;
          assertFloor(hidden.join(' '), decision, policy, `substitution at word ${i}`, true);
          hidden[i] = `"\${s4missing:-${words[i]}}"`;
          assertFloor(`unset s4missing; ${hidden.join(' ')}`, decision, policy, `unset variable at word ${i}`, true);
        }
        const code = words.join(' ');
        assertFloor(`s4code=$(printf %s ${quote(code)}); eval "$s4code"`, decision, policy, 'dynamic eval', true);
        assertFloor(`s4code=$(printf %s ${quote(code)}); bash -c "$s4code"`, decision, policy, 'dynamic bash -c', true);
      }
    }
  });

  test(
    'generated chains remain at least ask after a value is hidden',
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...seeds),
          fc.nat(),
          fc.constantFrom('word', 'unset', 'eval', 'bash'),
          fc.array(fc.constantFrom(...wrappers), { minLength: 1, maxLength: 3 }),
          ({ words, decision }, index, method, chain) => {
            const code = words.join(' ');
            let hidden: string;
            if (method === 'word' || method === 'unset') {
              const parts = [...words];
              const i = index % parts.length;
              parts[i] = method === 'word' ? `"$(printf %s ${quote(parts[i]!)})"` : `"\${s4missing:-${parts[i]}}"`;
              hidden = `${method === 'unset' ? 'unset s4missing; ' : ''}${parts.join(' ')}`;
            } else {
              hidden = `s4code=$(printf %s ${quote(code)}); ${method === 'eval' ? 'eval' : 'bash -c'} "$s4code"`;
            }
            for (const policy of policies) {
              let source = hidden;
              let before = assertFloor(source, decision, policy, method, true);
              for (const wrapper of chain) {
                source = wrapper.apply(source);
                before = assertFloor(source, before, policy, wrapper.name);
              }
            }
          },
        ),
        { numRuns: runs },
      );
    },
    { timeout },
  );
});
