import { forEachChild, type SyntaxNode } from 'unbash';
import type { Arg } from './types.ts';

/**
 * What reads secrets (`secrets:read`): files that hold credentials, variables named like one, and commands that print
 * the whole environment.
 */

/**
 * Names under any directory that hold a secret: `.env` and its variants, SSH and TLS private keys, keystores, Terraform
 * state and variables, and tools' credentials files.
 */
const secretNames =
  /^(\.env(\..+|~)?|\.envrc|\.dev\.vars|id_(rsa|dsa|ecdsa|ed25519)(_sk)?|.+\.(pem|key|p12|pfx|p8|ppk|jks|keystore|kdbx|tfstate|tfstate\.backup|tfvars|tfvars\.json)|\.netrc|_netrc|\.pgpass|\.my\.cnf|\.htpasswd|\.git-credentials|\.npmrc|\.pypirc|\.dockercfg|\.vault-token|\.terraformrc|terraform\.rc|credentials\.tfrc\.json|secring\.gpg|\.s3cfg|\.boto)$/;

/** `.env` files that hold no secret: templates (names and placeholders), and source files named after them. */
const notSecret = /^\.env\.((example|sample|template|dist|defaults)|(d\.)?[cm]?[jt]sx?|py|rb|go|rs)$/;

/** Files named for what they hold in the directory they're in: `.aws/credentials`, `.kube/config`. */
const secretPaths = new RegExp(
  `(^|/)(${[
    String.raw`\.aws/(credentials|sso/cache/.+|cli/cache/.+)`,
    String.raw`\.kube/(?!kuberc$)[^/]+`,
    String.raw`\.docker/config\.json`,
    String.raw`\.config/gh/hosts\.yml`,
    String.raw`\.config/gcloud/.+`,
    String.raw`\.azure/.+`,
    String.raw`\.cargo/credentials(\.toml)?`,
    String.raw`\.gnupg/private-keys-v1\.d/.+`,
    String.raw`\.ssh/(?!(.+\.pub|known_hosts(\.old)?|config|authorized_keys)$)[^/]+`,
    String.raw`\.config/git/credentials`,
    String.raw`\.claude/\.credentials\.json`,
    String.raw`\.codex/auth\.json`,
    String.raw`\.config/github-copilot/.+`,
    String.raw`\.config/hub`,
    String.raw`\.config/glab-cli/config\.yml`,
    String.raw`\.gem/credentials`,
    String.raw`\.m2/settings(-security)?\.xml`,
    String.raw`\.gradle/gradle\.properties`,
    String.raw`(\.composer|\.config/composer)/auth\.json`,
    String.raw`\.config/rclone/rclone\.conf`,
    String.raw`\.oci/config`,
    String.raw`\.config/doctl/config\.yaml`,
    String.raw`\.fly/config\.yml`,
    String.raw`\.local/share/com\.vercel\.cli/auth\.json`,
    String.raw`\.config/netlify/config\.json`,
    String.raw`\.wrangler/config/default\.toml`,
    String.raw`etc/ssl/private/.+`,
    String.raw`proc/[^/]+(/task/[^/]+)?/environ`,
  ].join('|')})$`,
);

/**
 * One file of each kind `secretNames` and `secretPaths` match, for testing a glob against: `*` stands for any one
 * directory.
 */
const examples = [
  ...'.env .env.local .env~ .envrc .dev.vars id_rsa id_dsa id_ecdsa id_ed25519 id_ed25519_sk .netrc _netrc .pgpass .my.cnf .htpasswd .git-credentials .npmrc .pypirc .dockercfg .vault-token .terraformrc terraform.rc credentials.tfrc.json secring.gpg .s3cfg .boto'.split(
    ' ',
  ),
  ...'pem key p12 pfx p8 ppk jks keystore kdbx tfstate tfstate.backup tfvars tfvars.json'.split(' ').map((extension) => `x.${extension}`),
  ...'.aws/credentials .aws/sso/cache/x.json .aws/cli/cache/x.json .kube/config .docker/config.json .config/gh/hosts.yml .config/gcloud/x .azure/x .cargo/credentials .cargo/credentials.toml .gnupg/private-keys-v1.d/x.key .ssh/x .config/git/credentials .claude/.credentials.json .codex/auth.json .config/github-copilot/x .config/hub .config/glab-cli/config.yml .gem/credentials .m2/settings.xml .m2/settings-security.xml .gradle/gradle.properties .composer/auth.json .config/composer/auth.json .config/rclone/rclone.conf .oci/config .config/doctl/config.yaml .fly/config.yml .local/share/com.vercel.cli/auth.json .config/netlify/config.json .wrangler/config/default.toml etc/ssl/private/x proc/*/environ proc/*/task/*/environ'.split(
    ' ',
  ),
].map((example) => example.split('/'));

/** A file named by Windows' 8.3 short name (`ENV~1` for `.env`) may be any file it shortens. */
const shortName = /(^|\/)[^/~]{1,6}~\d+(\.[^/.]{1,3})?$/;

/**
 * Whether a path, as written, resolved or real, names a file that holds secrets. Case is ignored, as Windows and macOS
 * ignore it. `short`: a short name may be one, where the word isn't a git revision (`HEAD~1`).
 */
export function secretFile(path: string, short = true): boolean {
  const lower = path.toLowerCase().replaceAll('\\', '/');
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  return (secretNames.test(name) && !notSecret.test(name)) || secretPaths.test(lower) || (short && shortName.test(path));
}

/**
 * Whether a glob, as written, may match a file that holds secrets: filled in with the least and the most its
 * wildcards may stand for, or matching one of `examples` (`.e?v`, `~/.aws/*`). A last part with no text of its own
 * (`*`) is only tested against paths, as it matches every file.
 */
export function secretGlob(glob: string): boolean {
  const lower = glob.toLowerCase().replaceAll('\\', '/').replace(/["']/g, '');
  const filled = (any: string) =>
    lower
      .replace(/\[!?\^?\]?[^\]]*\]/g, (set) => (/^\[[!^]/.test(set) ? 'x' : (set[1] ?? 'x')))
      .replaceAll('?', 'x')
      .replaceAll('*', any);
  if (secretFile(filled('')) || secretFile(filled('x'))) return true;
  const parts = lower.split('/').filter(Boolean);
  const own = /[^*?[\]]/.test(parts.at(-1) ?? '');
  return examples.some((example) => {
    if (parts.length < example.length || (example.length === 1 && !own)) return false;
    const tail = parts.slice(-example.length);
    return example.every((part, i) => part === '*' || globPart(tail[i]!).test(part));
  });
}

/** One part of a path glob as a regular expression: a wildcard first doesn't match a leading dot. */
function globPart(glob: string): RegExp {
  if (/[@!+?*]\(/.test(glob)) return /^/;
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    const end = char === '[' ? glob.indexOf(']', i + 2) : -1;
    if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (end !== -1) {
      const set = glob.slice(i + 1, end);
      const negated = /^[!^]/.test(set);
      source += `[${negated ? '^' : ''}${(negated ? set.slice(1) : set).replace(/[\\\]^[]/g, '\\$&')}]`;
      i = end;
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  try {
    return new RegExp(`^${/^[*?[]/.test(glob) ? '(?!\\.)' : ''}${source}$`);
  } catch {
    return /^/;
  }
}

/**
 * A variable named like a secret: one of its `_`-separated words ends in TOKEN, SECRET, PASSWORD, PASSWD, PASSPHRASE,
 * CREDENTIALS or APIKEY (`PGPASSWORD`), is PWD, PAT or SSHPASS (`MYSQL_PWD`, `GITHUB_PAT`), or it ends in KEY
 * (`OPENAI_API_KEY`). Not one named for where a secret is (`PASSWORD_STORE_DIR`) or meant to be public
 * (`NEXT_PUBLIC_…`), nor the working directory. Upper case only: the environment's names are, and a script's own
 * `token` or `key` is rarely one.
 */
export function secretVariable(name: string): boolean {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || name === 'PWD' || name === 'OLDPWD') return false;
  const words = name.split('_');
  if (words.includes('PUBLIC') || /^(DIR|FILE|PATH)$/.test(words.at(-1)!)) return false;
  return (
    words.some(
      (word) => /(TOKENS?|SECRETS?|PASSWORDS?|PASSWD|PASSPHRASE|CREDENTIALS?|APIKEY)$/.test(word) || /^(PWD|PAT|SSHPASS)$/.test(word),
    ) || words.at(-1) === 'KEY'
  );
}

/** A variable code expands: by name, or `indirect`, the one another's value names (`${!x}`). */
export interface Expanded {
  name: string;
  indirect: boolean;
}

/**
 * The variables a command's words, redirections, here-documents and arithmetic expand, but not those in its
 * substitutions. `${x:+y}` expands y, not x, and `${!x*}` and `${!x[@]}` only names and keys.
 */
export function expandedNames(node: SyntaxNode): Expanded[] {
  const names: Expanded[] = [];
  const identifier = /^[A-Za-z_]\w*/;
  const visit = (item: SyntaxNode) => {
    if (item.type === 'Script') return;
    if (item.type === 'SimpleExpansion') names.push({ name: item.text.slice(1), indirect: false });
    if (item.type === 'ParameterExpansion') {
      const { parameter, prefix, index, operation } = item;
      const listed = operation?.type === 'Names' || index?.value === '@' || index?.value === '*';
      const alternative = operation?.type === 'Default' && operation.operator.endsWith('+');
      if (prefix === '!') {
        if (!listed) names.push({ name: parameter, indirect: true });
      } else if (!alternative) {
        names.push({ name: parameter, indirect: false });
      }
      // A subscript is arithmetic, which evaluates a name in it.
      const subscript = index && identifier.exec(index.value)?.[0];
      if (subscript) names.push({ name: subscript, indirect: false });
    }
    if (item.type === 'ArithmeticWord') {
      const name = identifier.exec(item.value)?.[0];
      if (name) names.push({ name, indirect: false });
    }
    forEachChild(item, visit);
  };
  visit(node);
  return names;
}

const staticValue = (arg: Arg | undefined) => (arg?.kind === 'static' ? arg.value : undefined);

/**
 * Whether a program prints the environment, or a variable in it named like a secret: `printenv`, `env` with no
 * command, `export` and `declare -p` with no names, `set` alone, `ps e`, awk's `ENVIRON` (in its spec), jq's `env` and
 * `$ENV`, yq's `env()` and `strenv()`.
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
    case 'ps':
      return psEnvironment(args);
    case 'jq':
    case 'gojq':
    case 'jaq': {
      const filter = jqFilter(args);
      return filter === 'file' || filter?.kind === 'dynamic' || (filter !== undefined && /\$ENV\b|(^|[^\w$.])env\b/.test(filter.value));
    }
    case 'yq':
      return args.some(
        (arg, i) =>
          (arg.kind === 'dynamic' && !args.slice(0, i).some((before) => before.kind === 'dynamic' || !before.value.startsWith('-'))) ||
          (arg.kind === 'static' && (/\b(str)?env\s*\(|envsubst|\$ENV\b/.test(arg.value) || arg.value.startsWith('--from-file'))),
      );
    case null:
    default:
      return false;
  }
}

/**
 * Whether ps shows processes' environments: procps' BSD-style `e`, a word of letters with no dash anywhere among its
 * arguments, or BSD's `-E`. A word an option takes (`-o user`) is skipped.
 */
function psEnvironment(args: Arg[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.kind === 'dynamic') return true;
    const { value } = arg;
    if (value.startsWith('--')) {
      if (/^--(format|sort|pid|ppid|quick-pid|user|User|group|Group|tty|sid|cols|columns|lines|rows|width)$/.test(value)) i++;
    } else if (value.startsWith('-')) {
      if (value.includes('E')) return true;
      if (/[CGgOopqstUu]$/.test(value)) i++;
    } else if (/^[a-zA-Z]+$/.test(value)) {
      if (value.includes('e')) return true;
      if (/[OoptUk]$/.test(value)) i++;
    }
  }
  return false;
}

/** jq's filter: its first argument that isn't an option or an option's value, or `file` when it's read from one. */
function jqFilter(args: Arg[]): Arg | 'file' | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.kind === 'dynamic') return arg;
    const { value } = arg;
    if (/^--(arg|argjson|slurpfile|rawfile)$/.test(value)) i += 2;
    else if (/^(-L|--indent|--library-path)$/.test(value)) i++;
    else if (value === '--from-file' || /^-[a-zA-Z]*f/.test(value)) return 'file';
    else if (value === '--') return args[i + 1];
    else if (!value.startsWith('-') || value === '-') return arg;
  }
  return undefined;
}
