import { forEachChild, type SyntaxNode } from 'unbash';
import type { Arg } from './types.ts';

/**
 * What reads secrets (`secrets:read`): files that hold credentials, variables named like one, and commands that print
 * the whole environment.
 */

/** Names under any directory that hold a secret: `.env` and its variants, SSH and TLS private keys, keystores. */
const secretNames =
  /^(\.env(\..+)?|\.envrc|id_(rsa|dsa|ecdsa|ed25519)(_sk)?|.+\.(pem|key|p12|pfx|jks|keystore|tfstate|tfstate\.backup)|\.netrc|_netrc|\.pgpass|\.git-credentials|\.npmrc|\.pypirc|\.dockercfg|\.vault-token|\.terraformrc|terraform\.rc|credentials\.tfrc\.json|secring\.gpg)$/;

/** `.env` files that are templates: they hold names and placeholders, not values. */
const templates = /^\.env\.(example|sample|template|dist|defaults)$/;

/** Files named for what they hold in the directory they're in: `.aws/credentials`, `.kube/config`. */
const secretPaths =
  /(^|\/)(\.aws\/(credentials|sso\/cache\/.+|cli\/cache\/.+)|\.kube\/config|\.docker\/config\.json|\.config\/gh\/hosts\.yml|\.config\/gcloud\/.+|\.azure\/.+|\.cargo\/credentials(\.toml)?|\.gnupg\/private-keys-v1\.d\/.+|\.ssh\/(?!(.+\.pub|known_hosts(\.old)?|config|authorized_keys)$)[^/]+|proc\/[^/]+\/environ)$/;

/** A file named by Windows' 8.3 short name (`ENV~1` for `.env`) may be any file it shortens. */
const shortName = /(^|\/)[^/~]{1,6}~\d+(\.[^/.]{1,3})?$/;

/**
 * Whether a path, as written, resolved or real, names a file that holds secrets. Case is ignored, as Windows and macOS
 * ignore it. `short`: a short name may be one, where the word isn't a git revision (`HEAD~1`).
 */
export function secretFile(path: string, short = true): boolean {
  const lower = path.toLowerCase().replaceAll('\\', '/');
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  return (secretNames.test(name) && !templates.test(name)) || secretPaths.test(lower) || (short && shortName.test(path));
}

/**
 * A variable named like a secret: one of its `_`-separated words is TOKEN, SECRET, PASSWORD, PASSWD, PASSPHRASE or
 * CREDENTIALS, or it ends in KEY or APIKEY (`OPENAI_API_KEY`). Upper case only: the environment's names are, and a
 * script's own `token` or `key` is rarely one.
 */
export function secretVariable(name: string): boolean {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return false;
  const words = name.split('_');
  return words.some((word) => /^(TOKENS?|SECRETS?|PASSWORDS?|PASSWD|PASSPHRASE|CREDENTIALS?|APIKEY)$/.test(word)) || words.at(-1) === 'KEY';
}

/** The variables a command's words, redirections and here-documents expand, but not those in its substitutions. */
export function expandedNames(node: SyntaxNode): string[] {
  const names: string[] = [];
  const visit = (item: SyntaxNode) => {
    if (item.type === 'Script') return;
    if (item.type === 'SimpleExpansion') names.push(item.text.slice(1));
    if (item.type === 'ParameterExpansion') names.push(item.parameter);
    forEachChild(item, visit);
  };
  visit(node);
  return names;
}

const staticValue = (arg: Arg | undefined) => (arg?.kind === 'static' ? arg.value : undefined);

/**
 * Whether a program prints the environment, or a variable in it named like a secret: `printenv`, `env` with no
 * command, `export` and `declare -p` with no names, `set` alone, `ps e`.
 */
export function printsEnvironment(program: string | null, argv: Arg[], runs: boolean): boolean {
  const args = argv.slice(1);
  const names = args.filter((arg) => arg.kind === 'dynamic' || !arg.value.startsWith('-'));
  const named = (arg: Arg) => arg.kind === 'dynamic' || secretVariable(arg.value.split('=')[0]!);
  switch (program) {
    case 'printenv':
      return names.length === 0 || names.some(named);
    case 'env':
      return !runs;
    case 'export':
    case 'declare':
    case 'typeset': {
      const prints = program === 'export' || args.some((arg) => arg.kind === 'dynamic' || /^-\w*[px]/.test(arg.value)) || args.length === 0;
      return prints && (names.length === 0 || (args.some((arg) => staticValue(arg) === '-p') && names.some(named)));
    }
    case 'set':
      return args.length === 0;
    case 'ps': {
      // BSD-style options come first, with no dash: `e` shows each process's environment.
      const first = args[0];
      return first?.kind === 'dynamic' || (first !== undefined && /^[a-zA-Z]*e[a-zA-Z]*$/.test(first.value));
    }
    case null:
    default:
      return false;
  }
}
