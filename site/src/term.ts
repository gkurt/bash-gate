/** What both pages share: the status bar, the footer, the editors, and how a verdict is drawn. */
import pkg from '#package.json' with { type: 'json' };
import {
  allow,
  ask,
  check,
  deny,
  recommended,
  type Decision,
  type Environment,
  type FileSystem,
  type Policy,
  type Verdict,
} from '#src/index.ts';

export const REPO = 'https://github.com/gkurt/bash-gate';
const NPM = 'https://www.npmjs.com/package/bash-gate';
const THEME_KEY = 'bash-gate-theme';

const PAGES = [
  ['./', 'home'],
  ['tutorial.html', 'tutorial'],
] as const;

export const esc = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** The tmux-like bar at the top and the footer. `current` is the page's own href. */
export function mountChrome(current: (typeof PAGES)[number][0]) {
  const bar = document.createElement('nav');
  bar.className = 'bar';
  bar.innerHTML = `
    <a class="bar-session" href="./">[bash-gate]</a>
    <span class="bar-windows">${PAGES.map(
      ([href, name], index) =>
        `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${index}:${name}${href === current ? '*' : ''}</a>`,
    ).join('')}<a href="${REPO}/blob/main/THREAT_MODEL.md">${PAGES.length}:threat-model</a></span>
    <span class="bar-end">
      <a href="${NPM}">npm</a>
      <a href="${REPO}">github</a>
      <button type="button" class="bar-theme"></button>
      <time class="bar-clock"></time>
    </span>`;
  document.body.prepend(bar);

  const theme = bar.querySelector<HTMLButtonElement>('.bar-theme')!;
  const isDark = () =>
    (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'dark';
  const label = () => {
    theme.textContent = isDark() ? 'light' : 'dark';
    theme.setAttribute('aria-label', `Use ${theme.textContent} theme`);
  };
  theme.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage may be unavailable; the choice then lasts the visit.
    }
    label();
  });
  label();

  const clock = bar.querySelector('.bar-clock')!;
  const tick = () => {
    clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  };
  tick();
  setInterval(tick, 10_000);

  const footer = document.createElement('footer');
  footer.className = 'footer';
  footer.innerHTML = `
    <span><span class="dim">$</span> bash-gate --version <span class="dim">→</span> ${esc(pkg.version)} <span class="dim">· MIT</span></span>
    <span class="footer-links"><a href="${REPO}">github</a><a href="${NPM}">npm</a><a href="${REPO}/blob/main/README.md">readme</a><a href="${REPO}/blob/main/THREAT_MODEL.md">threat model</a></span>`;
  document.body.append(footer);
}

/**
 * A textarea over a highlighted copy of its text: the textarea takes the typing, the copy underneath shows the
 * colours. Both grow with the text.
 */
export function editor({
  value,
  label,
  render,
  onInput,
}: {
  value: string;
  label: string;
  render: (text: string) => string;
  onInput: (text: string) => void;
}) {
  const root = document.createElement('div');
  root.className = 'editor';
  const view = document.createElement('pre');
  view.setAttribute('aria-hidden', 'true');
  const input = document.createElement('textarea');
  input.spellcheck = false;
  input.autocapitalize = 'off';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('aria-label', label);
  input.rows = 1;
  input.value = value;
  root.append(view, input);
  const paint = () => {
    // A trailing newline (or no text at all) needs something after it to take up its line.
    view.innerHTML = render(input.value) + (input.value === '' || input.value.endsWith('\n') ? ' ' : '');
  };
  input.addEventListener('input', () => {
    onInput(input.value);
    paint();
  });
  paint();
  return {
    root,
    input,
    paint,
    set(text: string) {
      input.value = text;
      onInput(text);
      paint();
    },
  };
}

const RANK: Record<Decision, number> = { allow: 1, ask: 2, deny: 3 };
const BY_RANK = [undefined, 'allow', 'ask', 'deny'] as const;

/** The source, each character tinted by the most severe decision about the code it's part of. */
export function highlightSource(source: string, verdict: Verdict | undefined) {
  if (!verdict) return esc(source);
  const ranks = Array.from(source, () => 0);
  const mark = ([start, end]: [number, number], decision: Decision) => {
    for (let i = start; i < end && i < ranks.length; i++) ranks[i] = Math.max(ranks[i]!, RANK[decision]);
  };
  for (const invocation of verdict.analysis.invocations) if (invocation.kind !== 'function') mark(invocation.span, 'allow');
  for (const reason of verdict.reasons) mark(reason.span, reason.decision);
  let html = '';
  for (let start = 0; start < source.length;) {
    let end = start + 1;
    while (end < source.length && ranks[end] === ranks[start]) end++;
    const decision = BY_RANK[ranks[start]!];
    const text = esc(source.slice(start, end));
    html += decision ? `<mark class="${decision}">${text}</mark>` : text;
    start = end;
  }
  return html;
}

const JS_TOKENS =
  /(\/\/[^\n]*)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(allow|ask|deny)(?=\()|\b(recommended|true|false|null|undefined)\b|([A-Za-z_$][\w$]*)(?=\s*:)|(-?\d+(?:\.\d+)?)/g;

/** Just enough JavaScript highlighting for a policy or an environment. */
export function highlightJs(code: string) {
  let html = '';
  let last = 0;
  for (const match of code.matchAll(JS_TOKENS)) {
    html += esc(code.slice(last, match.index));
    const [text, comment, string, rule, constant, key] = match;
    const kind = comment ? 'comment' : string ? 'string' : rule ? match[3] : constant ? 'constant' : key ? 'key' : 'number';
    html += `<span class="js-${kind}">${esc(text)}</span>`;
    last = match.index + text.length;
  }
  return html + esc(code.slice(last));
}

/** Runs a JavaScript expression the reader wrote, in their own browser, with the library's rule helpers in scope. */
function evaluateJs(code: string): unknown {
  // oxlint-disable-next-line typescript/no-implied-eval -- running the policy the reader typed is the point of the editor
  const value: unknown = new Function('allow', 'ask', 'deny', 'recommended', `"use strict"; return (${code}\n);`)(
    allow,
    ask,
    deny,
    recommended,
  );
  return value;
}

/** A policy written as a JavaScript expression. Throws when it isn't one. */
export function evaluatePolicy(code: string): Policy {
  const value = evaluateJs(code);
  const invalid = new TypeError('a policy is an object with a `rules` array');
  if (typeof value !== 'object' || value === null || !('rules' in value)) throw invalid;
  const { rules } = value;
  if (!Array.isArray(rules)) throw invalid;
  return { ...value, rules };
}

/** An environment written as a JavaScript expression. Throws when it isn't an object. */
export function evaluateEnvironment(code: string): Environment {
  const value = evaluateJs(code);
  if (typeof value !== 'object' || value === null) throw new TypeError('an environment is an object');
  return value;
}

/** A filesystem from a few files: their directories exist, and everything else is known not to. */
export function virtualFs(files: Readonly<Record<string, string>>): FileSystem {
  const directories = new Set(['/']);
  for (const path of Object.keys(files))
    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) directories.add(path.slice(0, at));
  return {
    readFile: (path) => (Object.hasOwn(files, path) ? files[path]! : null),
    realpath: (path) => (Object.hasOwn(files, path) || directories.has(path) ? path : null),
  };
}

const MARK: Record<Decision, string> = { allow: '✓', ask: '?', deny: '✗' };

/** The verdict as a terminal would print it: each invocation with its decision, then the findings, then the outcome. */
export function renderVerdict(verdict: Verdict) {
  const { analysis, reasons } = verdict;
  let html = '';
  for (const invocation of analysis.invocations) {
    if (invocation.kind === 'function') {
      html += `<div class="row"><span class="badge fn">fn</span><span class="shape">${esc(invocation.shape)}</span><span class="meta">a function: its body is walked</span></div>`;
      continue;
    }
    const reason = reasons.find((r) => r.invocation === invocation);
    const decision = reason?.decision ?? 'allow';
    const meta = [
      invocation.via.length > 0 ? `via ${invocation.via.join(' › ')}` : '',
      invocation.nesting.length > 0 ? `in ${invocation.nesting.join(' › ')}` : '',
      ...invocation.effects.map((effect) => `<span class="effect">${effect}</span>`),
    ].filter(Boolean);
    html += `<div class="row ${decision}"><span class="badge">${decision}</span><span class="shape">${esc(invocation.shape)}</span><span class="meta">${meta.map((m) => (m.startsWith('<') ? m : esc(m))).join(' ')}</span></div>`;
    if (reason)
      html += `<div class="why ${decision}">└ ${reason.certain ? '' : '<span class="maybe">may match:</span> '}${code(reason.message)}</div>`;
  }
  for (const reason of reasons) {
    if (!reason.finding) continue;
    html += `<div class="row ${reason.decision}"><span class="badge">${reason.decision}</span><span class="shape finding">! ${esc(reason.finding.kind)}</span><span class="meta"></span></div>`;
    html += `<div class="why ${reason.decision}">└ ${code(reason.message)}</div>`;
  }
  const counts = [
    plural(analysis.invocations.length, 'invocation'),
    analysis.findings.length > 0 ? plural(analysis.findings.length, 'finding') : '',
  ].filter(Boolean);
  html += `<div class="outcome ${verdict.decision}">${MARK[verdict.decision]} ${verdict.decision.toUpperCase()} <span class="dim">· ${counts.join(', ')}</span></div>`;
  return html;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Backticked parts of a message as code. */
const code = (message: string) => esc(message).replace(/`([^`]+)`/g, '<code>$1</code>');

/** A command editor over its verdict, rerun on every keystroke. */
export function playground({
  command,
  policy,
  environment,
}: {
  command: string;
  policy: () => Policy | Error;
  environment?: () => Environment | Error;
}) {
  const root = document.createElement('div');
  root.className = 'playground';
  const output = document.createElement('div');
  output.className = 'report';
  output.setAttribute('aria-live', 'polite');
  let verdict: Verdict | undefined;
  const fail = (message: string) => {
    verdict = undefined;
    output.innerHTML = `<div class="error">error: ${esc(message)}</div>`;
  };
  const run = (source: string) => {
    const rules = policy();
    const env = environment?.() ?? {};
    if (rules instanceof Error) return fail(rules.message);
    if (env instanceof Error) return fail(env.message);
    try {
      verdict = check(source, rules, env);
      output.innerHTML = source.trim() ? renderVerdict(verdict) : '<div class="dim">type a command</div>';
    } catch (thrown) {
      fail(String(thrown));
    }
  };
  run(command);
  const input = editor({ value: command, label: 'Command', render: (text) => highlightSource(text, verdict), onInput: run });
  const line = document.createElement('div');
  line.className = 'prompt-line';
  line.innerHTML = '<span class="prompt" aria-hidden="true">$</span>';
  line.append(input.root);
  root.append(line, output);
  return {
    root,
    input,
    /** Runs the command again: after the policy or environment changed. */
    rerun() {
      run(input.input.value);
      input.paint();
    },
  };
}

/** Calls `run`, and turns what it throws into a value. */
export function attempt<T>(run: () => T): T | Error {
  try {
    return run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** A window frame with a title bar, around `body`. */
export function frame(title: string, body: HTMLElement, extra = '') {
  const root = document.createElement('div');
  root.className = 'window';
  root.innerHTML = `<div class="titlebar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="title">${esc(title)}</span>${extra}</div>`;
  root.append(body);
  return root;
}

/** Buttons that copy their `data-copy` text. */
export function wireCopyButtons(scope: ParentNode = document) {
  for (const button of scope.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    button.addEventListener('click', () => {
      navigator.clipboard.writeText(button.dataset.copy!).then(
        () => {
          button.classList.add('copied');
          setTimeout(() => button.classList.remove('copied'), 1200);
        },
        () => undefined,
      );
    });
  }
}
