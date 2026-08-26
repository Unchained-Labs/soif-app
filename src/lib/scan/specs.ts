import type { LocalScanSpec } from "./local-spec";

/**
 * Verified local-scan specs.
 *
 * Each one was built by reading the tool's own source or its real output, and
 * `verifiedFrom` names that evidence. Nothing here is inferred from a blog
 * post or from what a format "probably" looks like: a spec that reads zeros
 * looks exactly like a provider you simply did not use that month, which is
 * the most dangerous failure this dashboard has.
 *
 * Tools deliberately not covered here, and why:
 *
 *   goose      Stores sessions in SQLite (`sessions.db`), not JSONL. The
 *              schema is real but needs a different reader.
 *   opencode   Migrated to a versioned database with active migrations;
 *              building against a moving schema would break silently.
 *   cursor     `ai-code-tracking.db` records edits, not token usage.
 *   aider      Token counts live in analytics, not the chat history file.
 *
 * All of them are reachable today through `soif-scan --import` with a CSV
 * export, which is why the CSV path is a first-class source rather than a
 * fallback.
 */

/**
 * Gemini CLI.
 *
 * Sessions are JSONL under `~/.gemini/tmp/<projectHash>/chats/*.jsonl`. The
 * recorder writes Google's raw `usageMetadata` fields straight through:
 *
 *   input   = promptTokenCount        (INCLUDES cachedContentTokenCount)
 *   output  = candidatesTokenCount    (EXCLUDES thoughtsTokenCount)
 *   cached  = cachedContentTokenCount
 *   thoughts= thoughtsTokenCount      (separate from output; both sum into total)
 *   tool    = toolUsePromptTokenCount (prompt-side)
 *
 * Two conventions therefore apply at once, and getting either backwards is a
 * large error: the prompt total is inclusive like OpenAI's, while the thinking
 * tokens are *separate* from output, unlike anyone else's. Dropping them would
 * discard most of the decode cost on a thinking model.
 */
export const GEMINI_CLI_SPEC: LocalScanSpec = {
  kind: "gemini_cli_local",
  vendor: "google",
  label: "Gemini CLI (local scan)",
  verifiedFrom:
    "google-gemini/gemini-cli packages/core/src/services/chatRecordingTypes.ts and " +
    "chatRecordingService.ts (recordMessageTokens)",

  homeDirs: [".gemini"],
  envVar: "GEMINI_DIR",
  sessionsSubdir: ["tmp"],
  extension: ".jsonl",

  // `"type":"gemini"` marks an assistant turn; `"tokens"` marks the counts.
  prefilter: ['"tokens"', '"type":"gemini"'],
  usagePath: "tokens",
  recordType: { path: "type", equals: "gemini" },

  fields: {
    input: "tokens.input",
    cacheRead: "tokens.cached",
    output: "tokens.output",
    reasoning: "tokens.thoughts",
    extraInput: ["tokens.tool"],
  },
  modelPaths: ["model", "tokens.model"],
  timestampPaths: ["timestamp"],
  sessionPaths: ["sessionId"],
  projectPaths: ["cwd", "projectHash"],

  conventions: { input: "inclusive", reasoning: "separate" },
  reportsGeo: false,
};

/**
 * Qwen Code.
 *
 * A fork of Gemini CLI that kept the chat-recording service intact, so the
 * record shape is identical — only the home directory and the vendor differ.
 * Sharing the spec rather than copying it means a fix to the Gemini reader
 * cannot drift away from the Qwen one.
 */
export const QWEN_CODE_SPEC: LocalScanSpec = {
  ...GEMINI_CLI_SPEC,
  kind: "qwen_code_local",
  vendor: "other",
  label: "Qwen Code (local scan)",
  verifiedFrom: "QwenLM/qwen-code, a fork of gemini-cli retaining chatRecordingService",
  homeDirs: [".qwen"],
  envVar: "QWEN_DIR",
};

export const LOCAL_SCAN_SPECS: readonly LocalScanSpec[] = [GEMINI_CLI_SPEC, QWEN_CODE_SPEC];

export function specFor(kind: string): LocalScanSpec | undefined {
  return LOCAL_SCAN_SPECS.find((spec) => spec.kind === kind);
}
