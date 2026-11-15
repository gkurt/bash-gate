---
packages:
  'bash-gate': patch
---

### An alias's text is read as Bash reads it, a word at a time

After an alias whose text ends in a blank, Bash checks the next word for an alias, and keeps checking through that
alias's own text: its first word is expanded too, and so on. The analysis put the second alias's text in place
without that, so with `alias cat="env "` and `alias l="cat rm"`, `cat l -rf /` was `env cat rm -rf /`, reading files,
and allowed: Bash runs `env env rm -rf /`.

An alias also isn't expanded again only while Bash reads its own text. The analysis held it back for the rest of the
command, so in `a a`, with `alias a="ls;"`, the second `a` was a program; Bash expands it again.
