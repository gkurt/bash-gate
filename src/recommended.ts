import { allow, ask, deny, type Policy } from './policy.ts';

/**
 * A starting policy for gating an agent's commands: reading and looking around runs, everyday git runs, destructive
 * forms are denied, and anything that deletes, reaches the network, escalates, writes outside the working directory or
 * runs code the analysis can't see asks. Commands no rule covers ask.
 */
export const recommended: Policy = {
  default: 'ask',
  rules: [
    allow(
      'cat|head|tail|wc|stat|file|nl|od|strings|md5sum|sha1sum|sha256sum|sha512sum|cmp|tac|rev|base64|grep|egrep|fgrep|rg|ls|du|sort|cut|tr|paste|join|fold|fmt|column|diff|comm|jq|yq|realpath|readlink|basename|dirname|find|which|type|echo|printf|true|false|:|test|[|pwd|cd|pushd|popd|whoami|id|uname|seq|sleep|exit|return|set|shift|local|declare|export|read|unset|wait|mkdir|touch|cp|mv|tee',
    ),
    // Wrappers: what they run is judged on its own. Aliases are followed, so defining them is harmless.
    allow('env|xargs|timeout|nice|nohup|time|stdbuf|watch|alias|unalias|shopt'),
    allow('git status|log|show|diff|blame|describe|rev-parse|rev-list|ls-files|ls-tree|show-ref|cat-file|shortlog|reflog|grep|merge-base|help|version'),
    allow('git add|commit|switch|checkout|restore|stash|merge|rebase|cherry-pick|revert|branch|tag|mv|rm|fetch|pull|push|remote|config'),
    deny('git push', { options: ['--force', '--force-with-lease', '--force-if-includes', '--mirror', '--delete'], reason: 'Rewrites or deletes remote history' }),
    ask('git reset', { options: ['--hard', '--keep', '--merge'], reason: 'Discards uncommitted work' }),
    ask('git clean', { options: ['--force'], reason: 'Deletes untracked files' }),
    ask('git branch|tag', { options: ['--delete', '--force'], reason: 'Deletes or moves a ref' }),
    ask('git stash drop|clear', { reason: 'Deletes stashed work' }),
    deny('rm', { options: ['--recursive'], args: ['/', '/*', '~', '~/', '~/*', '..', '../*', '.', './'], reason: 'Recursively deletes a top-level directory' }),
    deny('rm', { options: ['--no-preserve-root'], reason: 'Lets rm delete /' }),
    ask({ effects: ['exec:arbitrary', 'exec:file', 'exec:remote', 'privilege', 'network', 'fs:delete'] }),
    ask({ writes: ['/**', '~', '~/**', '..', '../**'], reason: 'Writes outside the working directory' }),
    ask('uniq|xxd|tree', { writes: ['**'], reason: 'Writes through an output-file argument' }),
    ask({ writes: ['.git/config', '**/.git/config', '.git/hooks/**', '**/.git/hooks/**'], reason: 'Changes Git configuration or hooks that can run code later' }),
  ],
};
