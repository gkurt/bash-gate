---
packages:
  'bash-gate': patch
---

### trace: a wrapper's shell is covered only by the code that wrapper was given

- **`flock`, `script` and `watch`:** a system shell the wrapper starts (`sh -c CODE`) is covered when CODE is that invocation's own code: its `--command`, the word after `-c` in `flock FILE -c CODE`, or `watch`'s command words joined. Before, any word or run of words of any invocation of that wrapper did, and so did a word only known at run time anywhere in it (`flock -w "$T"`), whatever CODE was.
