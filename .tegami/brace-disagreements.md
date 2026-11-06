---
packages:
  'bash-gate': patch
---

### Words the parser reads differently from Bash fail closed

Bash closes a brace only after a comma: `{a}s,d}` is `a}s d`, which the parser read as text. A word whose braces Bash
expands differently from the parser is now only known at run time. A word with quotes or substitutions the parser
kept as plain text (`ls[ $(rm -rf /) ]''`, one word to Bash, which runs the substitution) is a parse error.
`compgen -C` runs its code as a substitution, so in POSIX mode without aliases.
