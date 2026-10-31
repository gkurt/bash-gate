---
packages:
  'bash-gate': minor
---

### `analyze` and `check` take one `Environment`, with a `FileSystem` that may not know

The `readFile` and `realpath` options are replaced by `fs: { readFile, realpath }`, where `null` is absent and `undefined` is unknown; `evaluate` takes no options. What it didn't know is an `unknown-file` finding and an entry in `analysis.needs`. `snapshot()` builds a `FileSystem` from records, and `checkAsync()` fetches the needs from an `AsyncFileSystem` over a few rounds.
