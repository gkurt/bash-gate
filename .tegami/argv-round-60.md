---
packages:
  'bash-gate': patch
---

### kubectl's `_` in flag names, Helm 3's klog flags, Go booleans set false, and `uniq --`

- **kubectl:** a flag name with `_` is read as with `-`, as kubectl normalizes it. `kubectl --insecure_skip_tls_verify delete events --all` runs `delete`, and `--proxy_url`, `--profile_output` and the like have the effects of their hyphenated spellings.
- **helm:** klog's flags, which Helm 3 adds hidden, are known. A bool among them (`--skip-headers`) takes no word, so `helm --skip-headers uninstall list rel` runs `uninstall`. `--log-file` and `--log-dir` are writes, and `--v` at 8 or more logs the Secrets client-go fetches.
- **Booleans set false:** `helm … --dry-run=server --hide-secret=false` prints Secrets, and `kubectl version --client=false` asks the server. Both are now read by the flag's value.
- **`uniq --`:** after `--`, `+N` is a file, the output when it's second. `uniq -- in +5` writes `+5`.
