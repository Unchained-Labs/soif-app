import { defineConfig } from "tsup";

/**
 * Builds the two CLI entry points declared in `package.json#bin`.
 *
 * Without this the published package advertises `soif-init` and `soif-scan`
 * and ships neither — `npx soif-scan` would fail on a fresh install with a
 * missing-file error, which is the worst possible first impression for a tool
 * whose whole pitch is "one command".
 *
 * `factors.json` and the native SQLite driver stay external: the first is
 * loaded from the package root so it can be swapped for a pinned factor set,
 * and the second is a native addon that cannot be bundled.
 */
export default defineConfig({
  entry: ["cli/soif-init.ts", "cli/soif-scan.ts"],
  outDir: "dist/cli",
  format: ["esm"],
  target: "node20",
  platform: "node",
  sourcemap: true,
  clean: true,
  // Resolve the `@/` alias the app uses, so the CLI bundles the same modules.
  tsconfig: "tsconfig.json",
  external: ["better-sqlite3", "postgres"],
  // No `banner` shebang here: both entry files already declare one, and esbuild
  // preserves it. Adding a second puts a `#!` on line 2, which is a syntax
  // error rather than a comment — the built binaries failed to start at all.
});
