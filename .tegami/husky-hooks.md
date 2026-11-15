---
packages:
  'bash-gate': minor
---

### Hooks husky wrote are followed to the project's own

husky's stub sources its dispatcher by a computed path (`. "$(dirname "$0")/h"`), so with a filesystem every git
command that runs a hook asked in a husky repository. A stub and dispatcher that are exactly what husky 9.0 or 9.1
writes are now followed to `.husky/<hook>`, and the line husky 7 and 8 put at a hook's top (`. "$(dirname -- "$0")/_/husky.sh"`)
is left out when its helper is husky's. `git commit` is judged by `.husky/pre-commit`, and runs nothing when there's
none. A husky file changed by hand is walked as it is, which asks.
