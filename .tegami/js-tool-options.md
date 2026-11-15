---
packages:
  'bash-gate': patch
---

### The JavaScript tools load only what the analysis sees

`vitest`, `jest`, `vite` and `tsdown` had no options in their specs, and run, so `vitest --globalSetup=/tmp/x.ts` was
allowed. Each now knows its options, and one it doesn't know is `exec:arbitrary`: cac and yargs take it as
configuration, which may load a module, in either camelCase or kebab-case. What loads code from the command line is
`exec:file`: a configuration file named there, jest's setup files, transforms and runners, and a reporter, pool,
environment, formatter, parser or plugin given by its path. `tsdown --on-success` is walked as shell code. Servers
(`vitest --ui`, `--api`, `--inspect`) are `network`, and `eslint --init` and `--inspect-config`, which fetch and run a
package, are `network` and `exec:arbitrary`. `vite`'s root, another project's, is `exec:file`.
