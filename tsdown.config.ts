import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts', trace: 'src/trace/index.ts' },
  format: 'esm',
  // Nothing in src but trace/ uses Node APIs, so the main entry serves browsers too (highlighting, explaining commands).
  platform: 'neutral',
  // trace/ runs on Node.
  deps: { neverBundle: [/^node:/] },
  dts: true,
  sourcemap: true,
  // trace.js builds the supervisor from its source, next to it.
  copy: [{ from: 'src/trace/supervisor.c', flatten: true }],
});
