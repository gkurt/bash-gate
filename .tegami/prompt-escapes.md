---
packages:
  'bash-gate': patch
---

### Prompt strings' escapes are decoded as Bash decodes them

Bash decodes a prompt string's escapes before it expands it, so `PS4='$(echo a\nrm -rf /) '` runs `rm -rf /`: `\n` is
a newline in the substitution. The analysis decoded only octal escapes, and allowed it. It now decodes `\n`, `\r`,
`\a`, `\e`, `\[` and `\]` too, and an escape whose value is only known at run time (`\s`, `\u`, `\w`, `\$` and the
others) in a prompt string that expands anything is a `dynamic-script` finding.

### `tsc` writes the file it's given, whatever its name

`tsc --outFile package.json` and `--tsBuildInfoFile` write that file, but only files of the kinds tsc emits counted as
changed after it, so a later `npm run` read the old scripts. A file named for tsc to write, or one biome's or tsc's
`--init` creates, now counts as changed; the files and directories they're given to work in still stand for files of
their kinds only.
