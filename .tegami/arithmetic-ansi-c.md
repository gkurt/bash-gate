---
packages:
  'bash-gate': patch
---

### `$'…'` in arithmetic is decoded before it's expanded, and a `#` inside a word starts no comment

Bash decodes ANSI-C quoting in arithmetic and subscripts, then expands what it holds: `$(( $'\x24(rm -rf /)' ))` runs
`rm`, which went unseen. And `x=<(cat a)#; rm -rf /` is one word and a command to Bash, where the parser read
`#; rm -rf /` as a comment: a `#` right after a word the parser ended is a parse error.
