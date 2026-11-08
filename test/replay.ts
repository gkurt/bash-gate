import * as fc from 'fast-check';

/**
 * Replays a failure fast-check reported, with the seed and path it printed:
 * `FUZZ_SEED=<seed> FUZZ_PATH=<path> bun test test/bash.test.ts -t 'generated scripts'`.
 */
const seed = process.env.FUZZ_SEED;
if (seed !== undefined) fc.configureGlobal({ seed: Number(seed), ...(process.env.FUZZ_PATH ? { path: process.env.FUZZ_PATH } : {}) });
