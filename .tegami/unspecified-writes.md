---
packages:
  'bash-gate': patch
---

### Files a program may write without naming them are unknown to later reads

With `fs`, a git command that rewrites the work tree (`checkout`, `stash`, `reset`, `merge`…) makes everything in it but `.git` unknown, and a program without a spec, one running code the analysis doesn't follow (`make`, `npm install`, `python3 -c`), or one whose spec writes without saying where makes every later read unknown: `git checkout evil && npm test` no longer trusts the `package.json` read before the checkout.
