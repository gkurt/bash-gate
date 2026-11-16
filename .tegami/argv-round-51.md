---
packages:
  'bash-gate': patch
---

### bun's command is the first word without a dash, and pnpm's `--color` takes `always`, `auto` or `never`

- bun picks its command as the first word that doesn't start with `-`, without skipping any option's value. When that word names a bun command but the spec read it as an option's value, the command is now `exec:arbitrary` and `network`. Before, `bun --title create test` was allowed as `bun test` although it runs `bun create`, which fetches and runs a package. `bun --cwd add test left-pad` was likewise allowed as `bun test`, but runs `bun add`.
- pnpm's `--color` takes `always`, `auto` or `never` from the next word, as its nopt types say. Before, `pnpm --color never exec rm -rf ../victim` was read as running the project's `never` script.
- A spec option's new `words` field names those values.
