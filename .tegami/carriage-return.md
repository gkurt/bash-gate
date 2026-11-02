---
packages:
  'bash-gate': patch
---

### A carriage return in code is a parse error

Git Bash (Bash on Windows) drops it from code it parses, where Bash on Linux and the parser keep it as part of a word: `cat <<'EOF'`
with a line `EOF\r` in the body, then `rm -rf /`, was allowed, and in Git Bash it runs `rm`.
