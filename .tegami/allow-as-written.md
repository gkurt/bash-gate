---
packages:
  'bash-gate': patch
---

### Allow rules no longer match a path as written

`allow({ writes: ['src/**'] })` allowed `cd /tmp && echo x > src/a`: the path as written matched, though it's `/tmp/src/a`. Allow rules now match only forms that say where a path is: resolved, from where the script starts, and real.
