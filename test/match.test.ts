import { expect, test } from 'bun:test';
import { analyze, deny, matchRule, type Tri } from '#src/index.ts';

// A gate that maps invocations to actions of its own matches them with `matchRule`, outside any policy.

test.each<[string, string, Tri]>([
  ['gh pr merge', 'gh pr merge 12 --squash', 2],
  ['gh pr merge', 'gh -R o/r pr merge 12', 2],
  ['gh pr merge', 'gh pr view 12', 0],
  ['git push', 'sudo git push origin main', 2],
  ['git push', '$tool push', 1],
  ['gh pr view|list', 'gh pr list', 2],
])('%s matches `%s`: %p', (command, source, expected) => {
  const analysis = analyze(source, { cwd: '/repo' });
  const best = Math.max(0, ...analysis.invocations.map((invocation) => matchRule(deny(command), invocation, analysis)));
  expect(best).toBe(expected);
});
