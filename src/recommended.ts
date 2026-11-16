import { allow, ask, deny, type Policy } from './policy.ts';

/**
 * A starting policy for gating an agent's commands: reading and looking around runs, everyday git runs, destructive
 * forms are denied, and anything that deletes, escalates, writes outside the working directory or runs code the
 * analysis can't see asks. So does the network, except to read from a git remote the repository already has, or from
 * GitHub through `gh` (`network:read`). Commands no rule covers ask.
 */
export const recommended: Policy = {
  default: 'ask',
  // Project code is allowed to run, so a file it may have changed is no more than what it could do itself.
  findings: { 'project-file': 'allow' },
  rules: [
    allow(
      'cat|head|tail|wc|stat|file|nl|od|strings|md5sum|sha1sum|sha224sum|sha256sum|sha384sum|sha512sum|b2sum|cksum|cmp|tac|rev|base64|grep|egrep|fgrep|rg|ls|du|df|sort|uniq|cut|tr|paste|join|fold|fmt|column|expand|unexpand|diff|comm|jq|yq|sed|awk|gawk|mawk|nawk|realpath|readlink|basename|dirname|find|which|type|echo|printf|true|false|:|test|[|pwd|cd|pushd|popd|whoami|id|uname|date|nproc|uptime|free|ps|pgrep|printenv|seq|sleep|exit|return|break|continue|set|shift|local|declare|export|read|unset|wait|mkdir|touch|cp|mv|tee',
    ),
    // Wrappers: what they run is judged on its own. Aliases are followed, so defining them is harmless.
    allow('env|xargs|timeout|nice|nohup|time|stdbuf|watch|alias|unalias|shopt'),
    allow(
      'git status|log|show|diff|blame|annotate|describe|rev-parse|rev-list|ls-files|ls-tree|ls-remote|show-ref|cat-file|shortlog|reflog|whatchanged|grep|merge-base|name-rev|count-objects|var|check-ignore|check-attr|for-each-ref|help|version',
    ),
    allow('git add|commit|switch|checkout|restore|stash|merge|rebase|cherry-pick|revert|branch|tag|mv|rm|fetch|pull|push|remote|config'),
    allow('git worktree list'),
    deny('git push', {
      options: ['--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '--prune'],
      reason: 'Rewrites or deletes remote history',
    }),
    ask('git reset', { options: ['--hard', '--keep', '--merge'], reason: 'Discards uncommitted work' }),
    ask('git clean', { options: ['--force'], reason: 'Deletes untracked files' }),
    ask('git branch|tag', { options: ['--delete', '--force'], reason: 'Deletes or moves a ref' }),
    // `checkout -B` and `switch -C` reset a branch that's there; `-f`, `--ours`, `--theirs` and paths overwrite changes.
    ask('git checkout|switch|restore', { options: ['--force', '--worktree'], reason: 'Discards uncommitted work or moves a ref' }),
    ask('git stash drop|clear', { reason: 'Deletes stashed work' }),
    ask('git stash export', { options: ['--to-ref'], reason: 'Moves a ref' }),
    // Aborting or skipping puts back the work tree from before, over a resolution and what's staged.
    ask('git merge|rebase|cherry-pick|revert', { options: ['--abort', '--skip'], reason: 'Discards uncommitted work' }),
    ask('git fetch', { options: ['--force', '--update-head-ok', '--refmap', '--prune-tags'], reason: 'Deletes or moves a local ref' }),
    // Package scripts, tests and builds: project code, as git hooks are, with the dependencies cargo and bun fetch as
    // they build or run (`network:read`). Their specs give `exec:arbitrary` to inline
    // code, options they read as configuration and commands from PATH, and `network` to what installs or publishes.
    allow('npm|pnpm|bun|cargo|tsc|tsgo|biome|oxlint|oxfmt|eslint|prettier|vitest|jest|tsdown|vite', {
      effects: ['exec:project', 'fs:read', 'fs:write', 'network:read'],
    }),
    // Only those of gh's commands that read: the others in these groups have `network`.
    allow('gh pr|issue|run|workflow|release|repo|search|label|cache|ruleset|discussion|project|org|status', {
      effects: ['network:read'],
    }),
    deny('rm', {
      options: ['--recursive'],
      args: ['/', '/*', '~', '~/', '~/*', '..', '../*', '.', './'],
      reason: 'Recursively deletes a top-level directory',
    }),
    deny('rm', { options: ['--no-preserve-root'], reason: 'Lets rm delete /' }),
    ask({ effects: ['exec:arbitrary', 'exec:file', 'exec:remote', 'privilege', 'network', 'fs:delete'] }),
    // Relative globs match from where the script starts, so `..` is anything outside it, `~` included. A path that can't
    // be placed against the start (no absolute `cwd`, or `~` with no `HOME`) may be outside it. Home itself isn't
    // named: most projects are in it.
    ask({ writes: ['..', '../**'], reason: 'Writes outside the working directory' }),
    // The user's own configuration that runs code later, even from a script started in HOME.
    ask({
      // The directories themselves too: `cp -r d/.ssh ~` writes into them under names only known at run time.
      writes: [
        '~/.gitconfig',
        '~/.config',
        '~/.config/git',
        '~/.config/git/**',
        '~/.ssh',
        '~/.ssh/**',
        '~/.bashrc',
        '~/.bash_aliases',
        '~/.bash_profile',
        '~/.bash_login',
        '~/.bash_logout',
        '~/.profile',
        '~/.zshrc',
        '~/.zprofile',
        '~/.zshenv',
        '~/.zlogin',
        '~/.zlogout',
        '~/.local',
        '~/.local/bin',
        '~/.local/bin/**',
        '~/bin',
        '~/bin/**',
        '~/.npmrc',
        '~/.bunfig.toml',
        '~/.cargo',
        '~/.cargo/config',
        '~/.cargo/config.toml',
      ],
      reason: "Changes the user's shell, Git or tools' configuration, or their PATH, which runs code later",
    }),
    ask('uniq|xxd|tree', { outputs: ['**'], reason: 'Writes through an output-file argument' }),
    ask('sed|awk|gawk|mawk|nawk', { outputs: ['**'], reason: 'Writes files its script names, or edits them in place' }),
    ask({
      writes: ['.git', '**/.git', '.git/**', '**/.git/**'],
      reason: 'Changes Git configuration or hooks that can run code later',
    }),
    // Git takes any directory with a HEAD, objects and refs as a repository, and runs what its config says.
    ask({ writes: ['HEAD', '**/HEAD'], reason: 'May make a directory a Git repository, whose config can run code' }),
  ],
};
