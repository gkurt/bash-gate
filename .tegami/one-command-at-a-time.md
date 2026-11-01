---
packages:
  'bash-gate': patch
---

### The threat model assumes nothing writes between the analysis and the end of the run

An integration runs commands one at a time, each once everything the last one started has exited: a background job
from an earlier command could rewrite a hook after the next was checked. `bash-gate/trace` already waits for daemons.
