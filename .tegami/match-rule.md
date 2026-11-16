---
packages:
  'bash-gate': minor
---

### `matchRule` matches one rule against one invocation

A gate that maps invocations to actions of its own, rather than to allow, ask and deny, can match them with the same three-valued rules a policy uses: `matchRule(deny('gh pr merge'), invocation, analysis)` is 0 (no), 1 (maybe) or 2 (yes). `Tri` and `Start` are exported with it.
