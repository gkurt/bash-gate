---
packages:
  'bash-gate': patch
---

### `xargs --process-slot-var`, `nohup.out`, `script`'s log, and variables that load code or write

- `xargs --process-slot-var=NAME` puts `NAME` in what it runs' environment: `PATH` there is sensitive, and a name only
  known at run time is `exec:arbitrary`.
- `nohup` writes `nohup.out` where it runs, and `script` without a file writes `typescript`.
- `GCONV_PATH` (glibc loads code from it), `GNUPGHOME` (its `gpg.conf` names programs), and `SSLKEYLOGFILE` and
  `GNUTLS_KEYLOGFILE` (TLS writes its secrets there) are sensitive.
