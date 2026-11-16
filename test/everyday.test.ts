import { describe, expect, test } from 'bun:test';
import { check, recommended, type Decision } from '#src/index.ts';

// What a coding agent runs all day, in an ordinary project, and the verdict `recommended` gives it. A soundness fix
// that changes one of these is a cost: it changes the line here, and says why in its commit.

const scripts = {
  build: 'tsc -p .',
  typecheck: 'tsc --noEmit',
  test: 'vitest run',
  lint: 'eslint .',
  format: 'prettier --write .',
  dev: 'vite',
};
/** The project at `root`, with `HOME` at `/home/me`: beside it (`/repo`), or around it (`/home/me/repo`), as most are. */
function environmentAt(root: string) {
  const files: Record<string, string> = {
    [`${root}/package.json`]: JSON.stringify({ name: 'app', scripts }),
    [`${root}/.git/HEAD`]: 'ref: refs/heads/main\n',
    [`${root}/.git/config`]:
      '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = git@example.com:a/app.git\n',
    [`${root}/Cargo.toml`]: '[package]\nname = "app"\n',
    [`${root}/src/index.ts`]: 'export {};\n',
    [`${root}/README.md`]: '# app\n',
  };
  return {
    cwd: root,
    env: { HOME: '/home/me', PATH: '/usr/bin:/bin' },
    fs: {
      readFile: (path: string) => files[path] ?? null,
      realpath: (path: string) => (path === root || path.startsWith(`${root}/`) || path === '/home/me' ? path : null),
    },
  };
}
export const everydayEnvironment = environmentAt('/repo');

export const everyday: [string, Decision][] = [
  // Reading
  ['ls -la', 'allow'],
  ['cat src/index.ts', 'allow'],
  ['head -n 50 README.md', 'allow'],
  ['grep -rn foo src', 'allow'],
  ['rg -n "export" src', 'allow'],
  ['find . -name "*.ts" -not -path "./node_modules/*"', 'allow'],
  ['wc -l src/*.ts', 'allow'],
  ['pwd', 'allow'],
  ['echo done', 'allow'],
  ['sed -n 1,20p src/index.ts', 'allow'],
  ['diff a.txt b.txt', 'allow'],
  ['jq .scripts package.json', 'allow'],
  ['cat package.json | jq -r .name', 'allow'],
  // git, reading
  ['git status', 'allow'],
  ['git status --short', 'allow'],
  ['git diff', 'allow'],
  ['git diff --stat HEAD~1', 'allow'],
  ['git log --oneline -20', 'allow'],
  ['git show HEAD', 'allow'],
  ['git branch -a', 'allow'],
  ['git blame src/index.ts', 'allow'],
  ['git rev-parse HEAD', 'allow'],
  // git, writing locally
  ['git add -A', 'allow'],
  ['git add src/index.ts', 'allow'],
  ['git commit -m "Fix it"', 'allow'],
  ['git add -A && git commit -m "Fix it"', 'allow'],
  ['git stash', 'allow'],
  ['git checkout -b feature', 'allow'],
  ['git switch main', 'allow'],
  // Package scripts and tools
  ['npm test', 'allow'],
  ['npm run build', 'allow'],
  ['npm run lint', 'allow'],
  ['npm run typecheck', 'allow'],
  ['pnpm test', 'allow'],
  ['bun test', 'allow'],
  ['bun run build', 'allow'],
  // npx downloads a package it doesn't find.
  ['npx tsc --noEmit', 'ask'],
  ['npx vitest run src', 'ask'],
  ['npx eslint src', 'ask'],
  ['npm run typecheck && npm test', 'allow'],
  ['npm run lint && npm run typecheck && npm test', 'allow'],
  ['cargo build', 'allow'],
  ['cargo test', 'allow'],
  ['cargo clippy -- -D warnings', 'allow'],
  ['cargo fmt', 'allow'],
  // Files in the project
  ['mkdir -p src/lib', 'allow'],
  ['touch src/lib/a.ts', 'allow'],
  ['cp src/index.ts src/copy.ts', 'allow'],
  ['mv src/copy.ts src/moved.ts', 'allow'],
  // recommended asks before deleting.
  ['rm src/moved.ts', 'ask'],
  ['echo "export {};" > src/b.ts', 'allow'],
  // Shell around them
  ['cd src && ls', 'allow'],
  ['npm test 2>&1 | tail -n 40', 'allow'],
  ['for f in src/*.ts; do wc -l "$f"; done', 'allow'],
  ['test -f package.json && echo yes', 'allow'],
];

describe('everyday commands keep their verdicts', () => {
  for (const [source, decision] of everyday) {
    test(source, () => {
      expect(check(source, recommended, everydayEnvironment).decision).toBe(decision);
    });
  }
});

describe('everyday commands keep their verdicts in a project under HOME', () => {
  const underHome = environmentAt('/home/me/repo');
  for (const [source, decision] of everyday) {
    test(source, () => {
      expect(check(source, recommended, underHome).decision).toBe(decision);
    });
  }
});
