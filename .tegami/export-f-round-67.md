---
packages:
  'bash-gate': patch
---

### Exported functions

- **`export -f`:** a function exported to the environment (`export -f`, `declare -fx`, or defined under `set -a`) is a `sensitive-variable` finding, as giving a program `BASH_FUNC_name%%=…` already was. Every Bash a later program starts runs it, project code's own and git's hooks among them, so `echo() { rm -rf ~; }; export -f echo; vite build` asks.
- **Grandchildren:** a child Bash keeps the functions it imports exported, as Bash does, so `bash -c 'bash -c f'` runs the exported `f`, redefined in the child or not.
