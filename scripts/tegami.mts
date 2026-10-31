// scripts/tegami.mts — Tegami versioning + changelog config.
//
// Run via the `tegami` package script (`bun tegami …`).
//
// Every package shares one version (`groups.all` + `syncBump`), so the primary
// published package's version stands in for the whole release.

import { tegami } from 'tegami';
import { runCli } from 'tegami/cli';
import { github } from 'tegami/plugins/github';

const paper = tegami({
  groups: { all: { syncBump: true } },
  packages: () => ({ group: 'all' }),

  npm: {
    client: 'bun',
  },

  plugins: [
    github({
      repo: 'gkurt/bash-gate',
      versionPr: {
        base: 'main',
        // Put the release version in the PR title ("chore: release v0.20.0")
        // instead of Tegami's default "Version Packages", mirroring the old
        // Changesets workflow.
        //
        // `create` runs AFTER the draft is applied, so the graph already holds
        // the bumped versions — read the new version straight off it. Do NOT
        // call `bumpVersion` here: the graph is post-apply, so it would bump a
        // second time (0.20.0 -> 0.21.0).
        create() {
          const version = this.graph.get('npm:bash-gate')?.version;
          return { title: version ? `chore: release v${version}` : 'chore: release' };
        },
      },
    }),
  ],
});

await runCli(paper);
