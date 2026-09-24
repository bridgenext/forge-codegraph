import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    /**
     * Several MCP integration tests (mcp-daemon, mcp-initialize, mcp-ppid-watchdog,
     * mcp-roots) spawn `dist/bin/codegraph.js serve --mcp` with `process.execPath`
     * and rely on the child inheriting `process.env`. On a Node >= 25 dev machine
     * the CLI's hard-block (src/bin/codegraph.ts) would otherwise exit the child
     * before it ever responds, so every spawn-based test times out — see #478.
     *
     * Setting the override here keeps the CLI's runtime guard intact for end
     * users (it's still enforced when `codegraph` is invoked directly) while
     * letting the test suite run on whatever Node the contributor happens to
     * have installed. CI on Node 22/23 is unaffected — the guard doesn't fire
     * there, so the variable is a no-op.
     */
    env: {
      CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
      /**
       * The suite spawns real CLI/MCP processes. This fork has no telemetry,
       * but the background update check still reaches github.com — keep the
       * suite fully offline and side-effect-free against the contributor's
       * real ~/.codegraph.
       */
      DO_NOT_TRACK: '1',
    },
    /**
     * Vitest defaults to a 5s per-test timeout. That is far too tight for this
     * suite: most tests build a real project on disk, index it with real
     * tree-sitter parsing in worker threads, and query real SQLite. Under the
     * parallel load of a full run — especially in a container or on a CI
     * runner — individual tests routinely exceed 5s and fail with "Test timed
     * out in 5000ms" even though nothing is wrong. Measured: a full Linux run
     * produced 5 such failures at the default and 1 at 30s, in a different set
     * of files each time, which is exactly the signature of a timeout that is
     * too small rather than of broken code.
     *
     * Raising it does not hide failures — a genuinely hung test still fails,
     * just later. It removes the noise that makes a real regression hard to
     * see. Tests that need longer already pass an explicit per-test timeout.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
