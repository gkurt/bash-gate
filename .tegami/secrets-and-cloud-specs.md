---
packages:
  'bash-gate': minor
---

### `secrets:read`: reading the environment, credentials files and secret variables

A new effect, which `recommended` asks about, for what reads a likely secret:

- the environment as a whole: `printenv`, `env` with no command, `export` or `export -p`, `declare -p`, `set` alone,
  `ps e`;
- a file that holds credentials, read, sourced, redirected or matched by a glob: `.env` and its variants (but
  templates like `.env.example`), `.envrc`, SSH private keys, `*.pem`, `*.key`, `.netrc`, `.npmrc`,
  `~/.aws/credentials`, `~/.kube/config`, gcloud and Azure credentials, `*.tfstate`, `/proc/*/environ`, in any case;
- a variable named like one, expanded in a command's words, redirections or here-documents (`echo $GITHUB_TOKEN`,
  `curl -H "Authorization: $API_KEY"`), but not one only tested with `test`;
- what kubectl, helm and terraform print of their own (below).

### Specs for kubectl, helm and terraform

- kubectl and helm read the cluster and chart repositories their config names as `network:read`, change them as
  `network`, and run commands in containers as `exec:remote` (`kubectl exec`, `run`, `debug`, `cp`). A word they
  don't know runs a plugin (`exec:arbitrary`); so do an editor (`kubectl edit`), a post-renderer, a getter plugin's
  scheme and kustomize's plugins and helm. A kubeconfig of their own may run a credential plugin (`exec:file`), and a
  server, kubeconfig or chart URL of their own is `network`. A `--dry-run` only reads.
- Printing a Secret (`kubectl get secret -o yaml`, `config view --raw`, `create token`, `helm get values`, `helm env`)
  is `secrets:read`. Changing the user's kubeconfig or helm configuration (`kubectl config use-context`, `helm repo
  add`, `helm registry login`) writes it, in HOME unless an option names another.
- terraform: `-chdir`, `-version` and `-help` before the command, options with one dash or two. `init`, `validate`,
  `plan` and `fmt` run the project's providers as project code (`exec:project`) and only read; `apply`, `destroy`,
  `import`, `test` and state changes are `network`; `output -json`, `output NAME`, `show -json`, `state pull`,
  `state show` and `console` are `secrets:read`. `TF_CLI_ARGS`, `KUBECONFIG`, `HELM_*` and the like are sensitive
  variables.
- `recommended` allows what only reads, plans or renders, and asks about the rest.
