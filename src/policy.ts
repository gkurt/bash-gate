import { analyze, type Environment } from './analyze.ts';
import { canonicalOption, specAt } from './argv.ts';
import { answer, answers, snapshot, type FileSystem } from './files.ts';
import { isSystemPath, relativePath, resolvePath, tildePath } from './paths.ts';
import { specFor } from './specs.ts';
import type { Analysis, Arg, Decision, Effect, Finding, FindingKind, Invocation, Need } from './types.ts';

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
  /** Like `writes`, for the files its own arguments name: not its redirections, which the shell opens. */
  outputs?: string[];
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
export function check(source: string, policy: Policy, environment?: Environment): Verdict {
  return evaluate(analyze(source, environment), policy);
}

/**
 * `check` with a filesystem that may answer with promises (a browser, a remote sandbox, just-bash): analyses with
 * what's been fetched, fetches what the analysis needed, and goes again, up to `rounds` times. What's still needed after the last round stays an `unknown-file`
 * finding.
 */
export async function checkAsync(
  source: string,
  policy: Policy,
  environment: Omit<Environment, 'fs'> & { fs: FileSystem },
  { rounds = 8 }: { rounds?: number } = {},
): Promise<Verdict> {
  const { fs } = environment;
  // A record for each method the filesystem has: what's in none of them isn't known yet.
  const record = <T>(kind: Need['kind']): Record<string, T | null> | undefined => (answers(fs, kind) ? Object.create(null) : undefined);
  const known = {
    files: record<string>('file'),
    realpaths: record<string>('realpath'),
    directories: record<string[]>('directory'),
    buffers: record<Uint8Array>('bytes'),
  };
  const records: { [K in Need['kind']]: Record<string, unknown> | undefined } = {
    file: known.files,
    realpath: known.realpaths,
    directory: known.directories,
    bytes: known.buffers,
  };
  for (let round = 1; ; round++) {
    const analysis = analyze(source, { ...environment, fs: snapshot(known) });
    if (analysis.needs.length === 0 || round >= rounds) return evaluate(analysis, policy);
    await Promise.all(
      analysis.needs.map(async ({ kind, path }) => {
        // What it can't say stays unknown, and is asked again.
        const value = await answer(fs, kind, path);
        if (value !== undefined) records[kind]![path] = value;
      }),
    );
  }
}

const severity: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

export function evaluate(analysis: Analysis, policy: Policy): Verdict {
  const reasons: Reason[] = [];
  for (const invocation of analysis.invocations) {
    if (invocation.kind !== 'function') reasons.push(decide(invocation, policy, analysis));
    // A function's body is judged command by command; the redirections on its call (`f > ../x`) are its own, judged
    // as they would be on `:`.
    else if (invocation.effects.length > 0 || invocation.writes.length > 0) reasons.push(decide(redirected(invocation), policy, analysis));
  }

  for (const finding of analysis.findings) {
    reasons.push({
      decision: policy.findings?.[finding.kind] ?? 'ask',
      message: finding.message,
      span: finding.span,
      certain: true,
      finding,
    });
  }
  const decision = reasons.reduce<Decision>(
    (worst, reason) => (severity[reason.decision] > severity[worst] ? reason.decision : worst),
    'allow',
  );
  return {
    decision,
    reasons: reasons.filter((reason) => reason.decision !== 'allow').sort((a, b) => severity[b.decision] - severity[a.decision]),
    analysis,
  };
}

/** A function call's redirections, as the builtin `:` with them. */
function redirected(invocation: Invocation): Invocation {
  const colon: Arg = { kind: 'static', value: ':' };
  return { ...invocation, program: ':', kind: 'builtin', argv: [colon], subcommands: [], options: {}, positionals: [], shape: ':' };
}

/** How a rule matches: 0 no, 1 maybe (a dynamic word could make it match), 2 yes. */
export type Tri = 0 | 1 | 2;

function decide(invocation: Invocation, policy: Policy, start: Start): Reason {
  const base = { span: invocation.span, invocation };
  const matches = policy.rules.map((rule) => [rule, matchRule(rule, invocation, start)] as const).filter(([, tri]) => tri > 0);
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
    floor = {
      ...base,
      decision: 'ask',
      certain: matchRule(asked, invocation, start) === 2,
      rule: asked,
      message: asked.reason ?? `Asks: ${describe(asked)}`,
    };
  }
  return floor && severity[floor.decision] >= severity[above.decision] ? floor : above;
}

/** Where the script starts, which relative globs are matched from (see `Analysis`). */
export type Start = Pick<Analysis, 'cwd' | 'realcwd' | 'home' | 'realhome'>;

/**
 * How `rule` matches `invocation`, read the cautious way for the rule's decision: 0 no, 1 maybe, 2 yes. Pass the
 * analysis as `start` so relative globs match from where the script starts. For a gate that maps invocations to its
 * own actions rather than to a policy's decision.
 */
export function matchRule(rule: Rule, invocation: Invocation, start: Start = {}): Tri {
  const all = rule.decision === 'allow';
  let result: Tri = 2;
  const and = (tri: Tri) => {
    if (tri < result) result = tri;
  };
  if (rule.command !== undefined) and(matchCommand(rule.command, invocation));
  if (rule.options && result > 0) and(matchOptions(rule.options, invocation, all));
  if (rule.args && result > 0) and(matchPaths(rule.args, invocation.positionals, invocation, all, start));
  if (rule.writes && result > 0) and(matchPaths(rule.writes, invocation.writes, invocation, all, start));
  if (rule.outputs && result > 0) and(matchPaths(rule.outputs, invocation.outputs, invocation, all, start));
  if (rule.effects && result > 0) and(matchEffects(rule.effects, invocation, all));
  return result;
}

function matchCommand(pattern: string, invocation: Invocation): Tri {
  if (invocation.program === null) return 1;
  const [program = '*', ...subcommands] = pattern
    .trim()
    .split(/\s+/)
    .map((token) => token.split('|'));
  if (!program.includes('*') && !program.includes(invocation.program)) return 0;
  for (const [k, alternatives] of subcommands.entries()) {
    const actual = invocation.subcommands[k];
    if (actual !== undefined) {
      if (!alternatives.includes('*') && !alternatives.includes(actual)) return 0;
      continue;
    }
    // A subcommand only known at run time may be any, and so may every level under it.
    const unknown = k === invocation.subcommands.length ? invocation.unknownSubcommand : undefined;
    if (unknown?.kind === 'dynamic') return 1;
    if (!unknown || !(alternatives.includes('*') || alternatives.includes(unknown.value)) || k < subcommands.length - 1) return 0;
  }
  return 2;
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
  const possible = invocation.maybeOptions
    ? [root, specAt(root, invocation.subcommands)].flatMap((spec) => spec?.options?.flatMap((option) => option.effects ?? []) ?? [])
    : [];
  if (all) {
    if (invocation.effects.some((effect) => !effects.includes(effect))) return 0;
    return invocation.program === null || possible.some((effect) => !effects.includes(effect)) ? 1 : 2;
  }
  if (effects.some((effect) => invocation.effects.includes(effect))) return 2;
  return invocation.program === null || effects.some((effect) => possible.includes(effect)) ? 1 : 0;
}

/**
 * Whether any of `args` matches any of `globs` (`all`: every one does), as written, as a path resolved against where
 * the invocation runs, and as its real path when the analysis had a filesystem. Relative globs match paths from where
 * the script starts. An allow rule doesn't match as written: after a `cd`, `src/a` is somewhere else. A path that can't be resolved, or whose real path isn't known, may be anywhere; one whose place
 * against the start isn't known may match any relative glob.
 */
function matchPaths(globs: string[], args: Arg[], invocation: Invocation, all: boolean, start: Start): Tri {
  const patterns = globs.map(globToRegExp);
  const anchored = (path: string) => !path.startsWith('/') && !path.startsWith('~');
  const absolute = globs.some((glob) => !anchored(glob));
  const relative = globs.some(anchored);
  const { realpaths } = invocation;
  let result: Tri = all ? 2 : 0;
  for (const arg of args) {
    if (arg.kind === 'dynamic') {
      result = 1;
      continue;
    }
    const resolved = resolvePath(invocation.cwd, arg.value, invocation.home);
    const physical = realpaths && resolved !== undefined && Object.hasOwn(realpaths, resolved) ? realpaths[resolved] : undefined;
    const local = resolved?.startsWith('/') && start.cwd !== undefined ? relativePath(resolved, start.cwd) : undefined;
    const realLocal = typeof physical === 'string' && typeof start.realcwd === 'string' ? relativePath(physical, start.realcwd) : undefined;
    const real = [physical, realLocal].filter((form) => typeof form === 'string');
    // `~` globs match where HOME really is too: a symlink to `~/.bashrc`, or HOME given by a path that leads there. And
    // HOME as it started, for a script that leaves it unknown without changing it (`declare -a HOME`).
    const homes = [invocation.home, start.home, typeof start.realhome === 'string' ? start.realhome : undefined];
    const forms = [
      all ? undefined : arg.value,
      resolved,
      ...homes.flatMap((home) => [resolved, ...real].map((path) => (path === undefined ? undefined : tildePath(path, home)))),
      local,
      ...real,
    ].filter((form) => typeof form === 'string');
    // On a filesystem that ignores case (Windows, macOS), `.GIT/config` is `.git/config`: a rule that may match is
    // tried on that spelling too. A rule that must match every path isn't.
    // Windows also names `.git` by its short name, `GIT~1`.
    // So does every other name there (`~/.BASHRC`), for the globs spelled in lower case.
    // Unicode's case folding takes `ſ` (long s) as `s`, which `toLowerCase` leaves as it is.
    if (!all) forms.push(...forms.flatMap((form) => [foldCase(form), foldCase(form.toLowerCase().replaceAll('ſ', 's'))]));
    const matches = patterns.some((pattern) => forms.some((form) => pattern.test(form)));
    const realMatches = patterns.some((pattern) => real.some((form) => pattern.test(form)));
    if (all && (!matches || (realpaths !== undefined && !realMatches))) return 0;
    if (!all && matches) return 2;
    // Windows also names a file by an 8.3 short name (`BASHRC~1` is `.bashrc`), which may be any name it shortens.
    const short = shortName.test(arg.value);
    const outside = short || resolved === undefined || resolved === '..' || resolved.startsWith('../') || physical === null;
    const unplaced =
      short ||
      resolved === undefined ||
      physical === null ||
      (!anchored(resolved) && local === undefined) ||
      (typeof physical === 'string' && realLocal === undefined);
    if (!all && ((outside && absolute) || (unplaced && relative))) result = 1;
  }
  return result;
}

/** A path with a name of Windows' 8.3 form, `NAME~N` or `NAME~N.EXT`. */
const shortName = /(^|\/)[^/~]{1,6}~\d+(\.[^/.]{1,3})?(\/|$)/;

/** `path` with the names git looks for spelled as git does: `.GIT`, `git~1` and `Head` are `.git` and `HEAD`. */
function foldCase(path: string): string {
  return path.replaceAll(/(^|\/)(?:\.git|git~\d+)(?=\/|$)/gi, '$1.git').replaceAll(/(^|\/)head(?=\/|$)/gi, '$1HEAD');
}

/** `**` crosses directories, `*` and `?` don't; everything else is literal. */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      source += '.*';
      i++;
    } else if (c === '*') {
      source += '[^/]*';
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // `**` matches any character, a newline included: a path may hold one.
  return new RegExp(`^${source}$`, 's');
}

function describe(rule: Rule): string {
  const parts = [rule.command ?? '*'];
  if (rule.options) parts.push(rule.options.join('|'));
  if (rule.args) parts.push(`args ${rule.args.join('|')}`);
  if (rule.writes) parts.push(`writes ${rule.writes.join('|')}`);
  if (rule.outputs) parts.push(`outputs ${rule.outputs.join('|')}`);
  if (rule.effects) parts.push(`effects ${rule.effects.join('|')}`);
  return `\`${parts.join(' ')}\``;
}
