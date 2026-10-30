import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  // Nothing in src uses Node APIs, so the same build serves browsers (highlighting, explaining commands).
  platform: 'neutral',
  dts: true,
  sourcemap: true,
});
