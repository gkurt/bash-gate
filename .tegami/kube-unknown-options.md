---
packages:
  'bash-gate': patch
---

### kubectl and helm options their specs don't know

- **Unknown options:** an option the kubectl or helm spec doesn't know, or a word that may be one, is `network`, as it already was for gh. Before, it had no effect at all, and the analysis relied on the program refusing it. But an option may name a host or a file of its own, or take the next word as its value (round 60's `--insecure_skip_tls_verify delete` and klog's hidden flags). So `kubectl get pods --not-a-flag` and `helm list $FLAGS` now ask.
- **Option lists checked:** the specs were checked against every command's `--help` in kubectl 1.35 and Helm 3.19 and 4.0, so real flags don't ask. The flags added include kubectl `run -f`/`-k`/`--wait`/`--force`, `top --show-swap`, `wait --local`, `create -l`, `create deployment -r`, `create job --from`, `kustomize --helm-*`, `--log-flush-frequency`, and helm `-l`, `plugin list --type` and rollback's server-side options. kubectl `kustomize -e` takes a value. Helm 4's `upgrade --server-side` and `rollback --server-side` take the next word.
