import { analyze, type AnalyzeOptions } from './analyze.ts';
import { canonicalOption, specAt } from './argv.ts';
import { isSystemPath, resolvePath } from './paths.ts';
import { specFor } from './specs.ts';
import type { Analysis, Arg, Decision, Effect, Finding, FindingKind, Invocation } from './types.ts';

/**
 * A rule matches an invocation when all its conditions do. Each condition is three-valued: it matches, it doesn't, or
 * it may (a dynamic word could make it match). Deny wins over ask, and ask over allow, whatever the order.
 */
export interface Rule {
  decision: Decision;
  /** The program, then subcommands, space-separated, alternatives after `|`, `*` for any: `'git push'`, `'npm run|test'`. */
  command?: string;
  /** Any of these options is given. Spellings are read with the program's spec, so `-f` finds `--force`. */
  options?: string[];
  /** Any positional matches any of these globs; a path also matches as resolved against where it runs. */
  args?: string[];
  /** Any file it writes (redirections included) matches any of these globs. */
  writes?: string[];
  /** It has any of these effects. */
  effects?: Effect[];
  reason?: string;
}

export interface Policy {
  rules: Rule[];
  /** For an invocation no rule decides. */
  default?: Decision;
  /** What each kind of finding means; `ask` when not given. */
  findings?: Partial<Record<FindingKind, Decision>>;
  /** A deny rule that only may match denies, rather than asks. */
  strict?: boolean;
}

export interface Reason {
  decision: Decision;
  message: string;
  span: [number, number];
  /** Whether it's known, or only may be so (a dynamic word may match a rule). */
  certain: boolean;
  invocation?: Invocation;
  finding?: Finding;
  rule?: Rule;
}

export interface Verdict {
  decision: Decision;
  /** Why, for each invocation and finding that isn't allowed, most severe first. */
  reasons: Reason[];
  analysis: Analysis;
}

type Conditions = Omit<Rule, 'decision'>;

export const allow = (command: string | Conditions, conditions?: Conditions): Rule => rule('allow', command, conditions);
export const ask = (command: string | Conditions, conditions?: Conditions): Rule => rule('ask', command, conditions);
export const deny = (command: string | Conditions, conditions?: Conditions): Rule => rule('deny', command, conditions);

function rule(decision: Decision, command: string | Conditions, conditions: Conditions = {}): Rule {
  return typeof command === 'string' ? { decision, command, ...conditions } : { decision, ...command };
}

/** Analyses `source` and decides it under `policy`. */
export function check(source: string, policy: Policy, options?: AnalyzeOptions): Verdict {
  return evaluate(analyze(source, options), policy);
}

const severity: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

export function evaluate(analysis: Analysis, policy: Policy): Verdict {
  const reasons: Reason[] = [];
  for (const invocation of analysis.invocations) {
    if (invocation.kind !== 'function') reasons.push(decide(invocation, policy));
  }
  for (const finding of analysis.findings) {
    reasons.push({ decision: policy.findings?.[finding.kind] ?? 'ask', message: finding.message, span: finding.span, certain: true, finding });
  }
  const decision = reasons.reduce<Decision>((worst, reason) => (severity[reason.decision] > severity[worst] ? reason.decision : worst), 'allow');
  return {
    decision,
    reasons: reasons.filter((reason) => reason.decision !== 'allow').sort((a, b) => severity[b.decision] - severity[a.decision]),
    analysis,
  };
}

/** No, maybe, yes. */
type Tri = 0 | 1 | 2;

function decide(invocation: Invocation, policy: Policy): Reason {
  const base = { span: invocation.span, invocation };
  const matches = policy.rules.map((rule) => [rule, match(rule, invocation)] as const).filter(([, tri]) => tri > 0);
  const hit = (decision: Decision, tri: Tri) => matches.find(([rule, t]) => rule.decision === decision && t === tri)?.[0];
  const denied = hit('deny', 2);
  if (denied) return { ...base, decision: 'deny', certain: true, rule: denied, message: denied.reason ?? `Denied: ${describe(denied)}` };
  const maybeDenied = hit('deny', 1);
  if (maybeDenied) {
    const message = `May match ${describe(maybeDenied)}${maybeDenied.reason ? ` (${maybeDenied.reason})` : ''}: arguments are only known at run time`;
    return { ...base, decision: policy.strict ? 'deny' : 'ask', certain: false, rule: maybeDenied, message };
  }
  const asked = hit('ask', 2) ?? hit('ask', 1);
  if (asked) return { ...base, decision: 'ask', certain: match(asked, invocation) === 2, rule: asked, message: asked.reason ?? `Asks: ${describe(asked)}` };
  const trusted = !invocation.path || isSystemPath(invocation.path);
  const allowed = trusted ? hit('allow', 2) : undefined;
  if (allowed) return { ...base, decision: 'allow', certain: true, rule: allowed, message: `Allowed: ${describe(allowed)}` };
  const why = trusted ? `No rule allows \`${invocation.shape}\`` : `\`${invocation.path}\` isn't a system program`;
  return { ...base, decision: policy.default ?? 'ask', certain: true, message: why };
}

function match(rule: Rule, invocation: Invocation): Tri {
  let result: Tri = 2;
  const and = (tri: Tri) => {
    if (tri < result) result = tri;
  };
  if (rule.command !== undefined) and(matchCommand(rule.command, invocation));
  if (rule.options && result) and(matchOptions(rule.options, invocation));
  if (rule.args && result) and(matchPaths(rule.args, invocation.positionals, invocation));
  if (rule.writes && result) and(matchPaths(rule.writes, invocation.writes, invocation));
  if (rule.effects && result) and(matchEffects(rule.effects, invocation));
  return result;
}

function matchCommand(pattern: string, invocation: Invocation): Tri {
  if (invocation.program === null) return 1;
  const [program = '*', ...subcommands] = pattern.trim().split(/\s+/).map((token) => token.split('|'));
  if (!program.includes('*') && !program.includes(invocation.program)) return 0;
  let result: Tri = 2;
  for (const [k, alternatives] of subcommands.entries()) {
    const actual = invocation.subcommands[k];
    if (actual !== undefined) {
      if (!alternatives.includes('*') && !alternatives.includes(actual)) return 0;
      continue;
    }
    const unknown = k === invocation.subcommands.length ? invocation.unknownSubcommand : undefined;
    if (unknown?.kind === 'dynamic') result = 1;
    else if (!unknown || !(alternatives.includes('*') || alternatives.includes(unknown.value)) || k < subcommands.length - 1) return 0;
  }
  return result;
}

function matchOptions(names: string[], invocation: Invocation): Tri {
  const root = invocation.program === null ? undefined : specFor(invocation.program);
  const leaf = specAt(root, invocation.subcommands);
  const canonical = (name: string) => {
    const atLeaf = canonicalOption(leaf, name);
    return atLeaf !== name ? atLeaf : canonicalOption(root, name);
  };
  if (names.some((name) => invocation.options[canonical(name)])) return 2;
  return invocation.maybeOptions || invocation.program === null ? 1 : 0;
}

function matchEffects(effects: Effect[], invocation: Invocation): Tri {
  if (effects.some((effect) => invocation.effects.includes(effect))) return 2;
  if (invocation.program === null) return 1;
  if (!invocation.maybeOptions) return 0;
  const root = specFor(invocation.program);
  const levels = [root, specAt(root, invocation.subcommands)];
  const possible = levels.flatMap((spec) => spec?.options?.flatMap((option) => option.effects ?? []) ?? []);
  return effects.some((effect) => possible.includes(effect)) ? 1 : 0;
}

/** Whether any of `args` matches any of `globs`, as written or as a path resolved against where the invocation runs. */
function matchPaths(globs: string[], args: Arg[], invocation: Invocation): Tri {
  const patterns = globs.map(globToRegExp);
  let result: Tri = 0;
  for (const arg of args) {
    if (arg.kind === 'dynamic') {
      result = 1;
      continue;
    }
    const resolved = resolvePath(invocation.cwd, arg.value);
    if (patterns.some((pattern) => pattern.test(arg.value) || (resolved !== undefined && pattern.test(resolved)))) return 2;
    const outside = resolved === undefined || resolved === '..' || resolved.startsWith('../');
    if (outside && globs.some((glob) => glob.startsWith('/') || glob.startsWith('~'))) result = 1;
  }
  return result;
}

/** `**` crosses directories, `*` and `?` don't; everything else is literal. */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      source += '.*';
      i++;
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function describe(rule: Rule): string {
  const parts = [rule.command ?? '*'];
  if (rule.options) parts.push(rule.options.join('|'));
  if (rule.args) parts.push(`args ${rule.args.join('|')}`);
  if (rule.writes) parts.push(`writes ${rule.writes.join('|')}`);
  if (rule.effects) parts.push(`effects ${rule.effects.join('|')}`);
  return `\`${parts.join(' ')}\``;
}
