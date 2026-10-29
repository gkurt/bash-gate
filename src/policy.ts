import { analyze, type AnalyzeOptions } from './analyze.ts';
import { canonicalOption, specAt } from './argv.ts';
import { isSystemPath, resolvePath } from './paths.ts';
import { specFor } from './specs.ts';
import type { Analysis, Arg, Decision, Effect, Finding, FindingKind, Invocation } from './types.ts';

/**
 * A rule matches an invocation when all its conditions do. Each condition is three-valued: it matches, it doesn't, or
 * it may (a dynamic word could make it match).
 *
 * Conditions read the cautious way for the rule's decision. A deny or ask rule matches when *any* option, positional,
 * write or effect fits, so having more never escapes it. An allow rule matches only when *all* of them fit, so having
 * more never earns it.
 *
 * A deny rule that matches denies. Deny rules that may match, and ask rules, set a floor (ask, or deny when strict);
 * allow rules and the default decide above it. So order doesn't matter, and nothing an invocation adds or hides
 * lowers its decision (S2 in THREAT_MODEL.md).
 */
export interface Rule {
  decision: Decision;
  /** The program, then subcommands, space-separated, alternatives after `|`, `*` for any: `'git push'`, `'npm run|test'`. */
  command?: string;
  /**
   * Deny and ask: any of these options is given. Allow: every option given is one of these. Spellings are read with
   * the program's spec, so `-f` finds `--force`.
   */
  options?: string[];
  /** Deny and ask: any positional matches any glob. Allow: every one does. Paths also match as resolved against where it runs. */
  args?: string[];
  /** Like `args`, for the files it writes, redirections included. */
  writes?: string[];
  /** Deny and ask: it has any of these effects. Allow: it has no others. */
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
  const matches = policy.rules.map((rule) => [rule, matchRule(rule, invocation)] as const).filter(([, tri]) => tri > 0);
  const hit = (decision: Decision, tri: Tri) => matches.find(([rule, t]) => rule.decision === decision && t === tri)?.[0];
  const denied = hit('deny', 2);
  if (denied) return { ...base, decision: 'deny', certain: true, rule: denied, message: denied.reason ?? `Denied: ${describe(denied)}` };
  const trusted = !invocation.path || isSystemPath(invocation.path);
  const allowed = trusted ? hit('allow', 2) : undefined;
  const why = trusted ? `No rule allows \`${invocation.shape}\`` : `\`${invocation.path}\` isn't a system program`;
  const above: Reason = allowed
    ? { ...base, decision: 'allow', certain: true, rule: allowed, message: `Allowed: ${describe(allowed)}` }
    : { ...base, decision: policy.default ?? 'ask', certain: true, message: why };
  const maybeDenied = hit('deny', 1);
  const asked = hit('ask', 2) ?? hit('ask', 1);
  let floor: Reason | undefined;
  if (maybeDenied) {
    const message = `May match ${describe(maybeDenied)}${maybeDenied.reason ? ` (${maybeDenied.reason})` : ''}: arguments are only known at run time`;
    floor = { ...base, decision: policy.strict ? 'deny' : 'ask', certain: false, rule: maybeDenied, message };
  } else if (asked) {
    floor = { ...base, decision: 'ask', certain: matchRule(asked, invocation) === 2, rule: asked, message: asked.reason ?? `Asks: ${describe(asked)}` };
  }
  return floor && severity[floor.decision] >= severity[above.decision] ? floor : above;
}

/** How `rule` matches `invocation`: 0 no, 1 maybe, 2 yes. Exported for the property tests. */
export function matchRule(rule: Rule, invocation: Invocation): Tri {
  const all = rule.decision === 'allow';
  let result: Tri = 2;
  const and = (tri: Tri) => {
    if (tri < result) result = tri;
  };
  if (rule.command !== undefined) and(matchCommand(rule.command, invocation));
  if (rule.options && result) and(matchOptions(rule.options, invocation, all));
  if (rule.args && result) and(matchPaths(rule.args, invocation.positionals, invocation, all));
  if (rule.writes && result) and(matchPaths(rule.writes, invocation.writes, invocation, all));
  if (rule.effects && result) and(matchEffects(rule.effects, invocation, all));
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

/** Any of `names` is given (`all`: every option given is one of `names`). */
function matchOptions(names: string[], invocation: Invocation, all: boolean): Tri {
  const root = invocation.program === null ? undefined : specFor(invocation.program);
  const leaf = specAt(root, invocation.subcommands);
  const canonical = new Set(
    names.map((name) => {
      const atLeaf = canonicalOption(leaf, name);
      return atLeaf !== name ? atLeaf : canonicalOption(root, name);
    }),
  );
  const unsure = invocation.maybeOptions || invocation.program === null;
  if (all) {
    if (Object.keys(invocation.options).some((name) => !canonical.has(name))) return 0;
    return unsure ? 1 : 2;
  }
  if (Object.keys(invocation.options).some((name) => canonical.has(name))) return 2;
  return unsure ? 1 : 0;
}

/** It has any of `effects` (`all`: it has no others). A dynamic option may be one with effects of its own. */
function matchEffects(effects: Effect[], invocation: Invocation, all: boolean): Tri {
  const root = invocation.program === null ? undefined : specFor(invocation.program);
  const possible = invocation.maybeOptions ? [root, specAt(root, invocation.subcommands)].flatMap((spec) => spec?.options?.flatMap((option) => option.effects ?? []) ?? []) : [];
  if (all) {
    if (invocation.effects.some((effect) => !effects.includes(effect))) return 0;
    return invocation.program === null || possible.some((effect) => !effects.includes(effect)) ? 1 : 2;
  }
  if (effects.some((effect) => invocation.effects.includes(effect))) return 2;
  return invocation.program === null || effects.some((effect) => possible.includes(effect)) ? 1 : 0;
}

/**
 * Whether any of `args` matches any of `globs` (`all`: every one does), as written or as a path resolved against
 * where the invocation runs. A path that can't be resolved may be anywhere.
 */
function matchPaths(globs: string[], args: Arg[], invocation: Invocation, all: boolean): Tri {
  const patterns = globs.map(globToRegExp);
  const absolute = globs.some((glob) => glob.startsWith('/') || glob.startsWith('~'));
  let result: Tri = all ? 2 : 0;
  for (const arg of args) {
    if (arg.kind === 'dynamic') {
      result = 1;
      continue;
    }
    const resolved = resolvePath(invocation.cwd, arg.value);
    const matches = patterns.some((pattern) => pattern.test(arg.value) || (resolved !== undefined && pattern.test(resolved)));
    if (all && !matches) return 0;
    if (!all && matches) return 2;
    const outside = resolved === undefined || resolved === '..' || resolved.startsWith('../');
    if (!all && outside && absolute) result = 1;
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
