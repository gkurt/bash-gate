---
packages:
  'bash-gate': patch
---

### kubectl, helm and terraform: dry runs that aren't, and more they print, fetch or write

- A dry run doesn't count when the command has an option its spec doesn't know, or a word that may be one: it may take the dry-run option as its value (`kubectl run --detach-keys --dry-run=client`).
- A `kubectl --raw` request ignores the dry run.
- These print secrets:
  - `kubectl config view` with or without `--raw`;
  - `kubectl -v=8` and up on a Secret;
  - a helm install or upgrade dry run with `--reuse-values` or `=server`, unless `--hide-secret` is given.
- These reach the network:
  - a URL in a comma-separated `-f` or `--values`;
  - a kustomization named by host (`github.com/org/repo`, `deploy@host:repo`);
  - `terraform workspace select -or-create`.
- `helm repo index` and `dependency build|update` write into the directory they're given.
- `recommended` asks about writes under `~/.kube`.
