---
packages:
  'bash-gate': patch
---

### secrets:print follows a secret through variables, pipes and output sent back

`secrets:print` now marks more of the ways a secret reaches the script's output whole:

- a variable assigned it, read into it or looped over it, and a substitution that read it (`x=$(cat .env); echo "$x"`, `echo "$(cat .env)"`);
- a pipe into a wrapper, function, loop, group, path-named or unknown program, any of which may pass it on (`| env cat`, `| while read l; do echo "$l"; done`), or a `tee` onto `/dev/stderr` mid-pipe;
- output sent back from a capture on purpose (`x=$(cat .env >&2)`, `>&3`, `> >(cat)`, `/proc/self/fd/1`, `/dev/pts/0`);
- `set -x` tracing an expanded secret;
- `hexdump`, `rev`, `sort`, `uniq`, `paste`, `join`, `diff`, `comm`, `zcat`, `dd` without `of=`, `cp` onto `/dev/stdout`, and `git show`, `cat-file` and `diff`.

Only a secret's length or a part of it (`${#GITHUB_TOKEN}`, `${x:0:4}`, `${x//?/*}`) no longer counts as printed. Neither does closed standard output (`1<&-`), and `.env.local.example`-style templates no longer count as secrets.
