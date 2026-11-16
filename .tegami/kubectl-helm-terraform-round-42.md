---
packages:
  'bash-gate': patch
---

### kubectl, helm and terraform ask when a dry run is off, a Secret is printed, or a host is their own

kubectl, helm and terraform ask in more of the cases that change, print or reach something:

- helm's `--dry-run=false` (or `0`), which Go reads as a real run;
- `kubectl config view --flatten`;
- a percent-encoded `kubectl get --raw` path;
- upper-case output formats, and a Secret printed by any kubectl command with `-o` (`label`, `annotate`, `wait`);
- `helm status -o json`;
- helm repositories from `--repository-config`, `--repository-cache` or `XDG_CACHE_HOME`/`XDG_DATA_HOME`;
- `terraform init -migrate-state`, `-force-copy` or `-backend-config=KEY=VALUE`;
- `terraform fmt -check=false`, which writes;
- `terraform providers lock -net-mirror`.
