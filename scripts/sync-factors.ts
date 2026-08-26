/**
 * Refresh the vendored `factors.json` from the `soif` repo.
 *
 * The factor tables have one source of truth — `src/soif/factors.py` upstream —
 * and this repo consumes the generated artifact rather than a hand-port. Run
 * this after a factor-set release, then run the test suite: the parity vectors
 * travel inside the file, so a bad sync fails loudly instead of quietly
 * changing every number on the dashboard.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFactorSet } from "@/lib/soif/factors";

const TARGET = fileURLToPath(new URL("../factors.json", import.meta.url));
const LATEST = "https://raw.githubusercontent.com/Unchained-Labs/soif/main/factors.json";

async function main(): Promise<void> {
  const source = process.argv[2] ?? LATEST;
  console.log(`fetching ${source}`);

  const raw = source.startsWith("http")
    ? await fetch(source).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
    : (await import("node:fs")).readFileSync(source, "utf8");

  // Validate before overwriting: a truncated download that still parses as
  // JSON would otherwise replace a good factor set with a broken one.
  const parsed = parseFactorSet(raw, source);
  if (!parsed.parity_vectors?.length) {
    throw new Error("factor set carries no parity vectors; refusing to install it");
  }

  writeFileSync(TARGET, raw.endsWith("\n") ? raw : `${raw}\n`, "utf8");
  console.log(
    `installed factor set ${parsed.factors_version} ` +
      `(schema ${parsed.schema_version}, ${parsed.parity_vectors.length} parity vectors)`,
  );
  console.log("now run: npm test");
}

main().catch((error) => {
  console.error(`sync-factors: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
