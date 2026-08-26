import type { InputConvention } from "./normalize";

/**
 * The provider catalogue.
 *
 * Water intensity is not a property of "an LLM call" — it depends on whose
 * data centres served it. OpenAI runs on Azure (WUE ~0.49 L/kWh), Anthropic on
 * AWS (~0.18), Google on its own fleet (~1.10). That is a 6x spread on the
 * on-site term alone, which is why the vendor has to travel with every record
 * rather than being inferred at render time.
 *
 * soif's model registry already resolves a *model name* to a provider preset,
 * so this table does not duplicate that. What it holds is the ingestion-side
 * knowledge: where a provider's usage can be read from, what its token
 * accounting means, and what to tell the user when it cannot be read at all.
 */

export type VendorId =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "mistral"
  | "deepseek"
  | "meta"
  | "qwen"
  | "moonshot"
  | "zai"
  | "cohere"
  | "amazon"
  | "microsoft"
  | "openrouter"
  | "other";

/** How a source gets its data. */
export type SourceKind =
  | "claude_code_local"
  | "codex_local"
  | "gemini_cli_local"
  | "qwen_code_local"
  | "anthropic_admin"
  | "openai_admin"
  | "claude_enterprise"
  | "claude_personal"
  | "chatgpt_personal"
  | "csv";

export interface ProviderSpec {
  kind: SourceKind;
  vendor: VendorId;
  /** Shown in the UI and the wizard. */
  label: string;
  /** One line explaining what this reads, for the sources card. */
  description: string;
  /** `local` needs no credential; `api` needs a key; `import` is a file. */
  transport: "local" | "api" | "import";
  /** How this provider reports prompt tokens. Drives `normalizeTokens`. */
  inputConvention: InputConvention;
  /** Whether the source reports real geographic routing. */
  reportsGeo: boolean;
  /** Credential prefix to expect, for the wizard to validate before spending a request. */
  credentialPrefix?: string;
  /** Docs link for obtaining the credential. */
  credentialHelp?: string;
  /**
   * `available` — wired and usable.
   * `planned`   — buildable, not built yet.
   * `unreadable`— cannot be built, because the vendor exposes no usage data.
   *
   * The third value exists so the UI can say so plainly instead of leaving a
   * gap. Never inventing a data source is one of this project's load-bearing
   * rules, and a silently absent card is a quiet way to break it.
   */
  status: "available" | "planned" | "unreadable";
  /**
   * How much this adapter has actually been proven.
   *
   * The dashboard shows this, because "we support Gemini" means something very
   * different when it has been run against a real corpus versus built from a
   * schema. A source that reads zeros is indistinguishable from a provider you
   * did not use, so the confidence has to travel with the claim.
   */
  verification?: "real-corpus" | "vendor-source" | "fixture-only";
  /** What the adapter was built from, when it is not obvious. */
  verifiedFrom?: string;
}

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    kind: "claude_code_local",
    vendor: "anthropic",
    label: "Claude Code (local scan)",
    description:
      "Reads real per-message usage out of local transcripts. Works on any plan including " +
      "personal Pro/Max, needs no credential, and never leaves the machine.",
    transport: "local",
    // Anthropic reports cache reads separately from input_tokens.
    inputConvention: "disjoint",
    reportsGeo: true,
    status: "available",
    verification: "real-corpus",
    verifiedFrom: "Run against a 527 MB / 255-file corpus of real transcripts.",
  },
  {
    kind: "codex_local",
    vendor: "openai",
    label: "Codex CLI (local scan)",
    description:
      "Reads per-turn token counts out of Codex session rollouts in ~/.codex. Works on any " +
      "ChatGPT plan, needs no credential, and never leaves the machine.",
    transport: "local",
    // OpenAI reports input_tokens as the whole prompt, cached reads a subset.
    inputConvention: "inclusive",
    reportsGeo: false,
    status: "available",
    verification: "vendor-source",
    verifiedFrom: "steipete/CodexBar rollout fixtures and its Codex token accounting.",
  },
  {
    kind: "gemini_cli_local",
    vendor: "google",
    label: "Gemini CLI (local scan)",
    description:
      "Reads per-message token counts out of Gemini CLI chat recordings in ~/.gemini. Works on " +
      "any plan, needs no credential, and never leaves the machine.",
    transport: "local",
    // promptTokenCount includes cachedContentTokenCount.
    inputConvention: "inclusive",
    reportsGeo: false,
    status: "available",
    verification: "vendor-source",
    verifiedFrom: "google-gemini/gemini-cli chatRecordingService.ts and chatRecordingTypes.ts.",
  },
  {
    kind: "qwen_code_local",
    vendor: "qwen",
    label: "Qwen Code (local scan)",
    description:
      "Reads Qwen Code chat recordings in ~/.qwen. Same on-disk format as Gemini CLI, which it " +
      "forked, so the two share one reader.",
    transport: "local",
    inputConvention: "inclusive",
    reportsGeo: false,
    status: "available",
    verification: "fixture-only",
    verifiedFrom: "QwenLM/qwen-code retains gemini-cli's chatRecordingService.",
  },
  {
    kind: "anthropic_admin",
    vendor: "anthropic",
    label: "Anthropic Admin API",
    description:
      "Real token counts by model, inference geography and workspace from " +
      "/v1/organizations/usage_report/messages. Org accounts only.",
    transport: "api",
    inputConvention: "disjoint",
    reportsGeo: true,
    credentialPrefix: "sk-ant-admin",
    credentialHelp: "https://console.anthropic.com/settings/admin-keys",
    status: "available",
    verification: "fixture-only",
  },
  {
    kind: "openai_admin",
    vendor: "openai",
    label: "OpenAI organization usage",
    description:
      "Per-model token counts by bucket from /v1/organization/usage/completions. " +
      "Needs an organization admin key.",
    transport: "api",
    inputConvention: "inclusive",
    reportsGeo: false,
    credentialPrefix: "sk-",
    credentialHelp: "https://platform.openai.com/settings/organization/admin-keys",
    status: "available",
    verification: "fixture-only",
  },
  {
    kind: "csv",
    vendor: "other",
    label: "CSV import",
    description:
      "Universal escape hatch: any provider, any export, as long as it has a timestamp, a model " +
      "and token counts.",
    transport: "import",
    // Declared per-file by the importer, since a CSV can come from anywhere.
    inputConvention: "disjoint",
    reportsGeo: false,
    status: "available",
    verification: "real-corpus",
    verifiedFrom: "Round-tripped with multi-vendor exports.",
  },
  {
    kind: "claude_personal",
    vendor: "anthropic",
    label: "Claude Pro / Max personal",
    description:
      "Individual subscriptions expose no documented usage API, so history cannot be pulled. " +
      "Anthropic's own docs state the Admin API is unavailable for individual accounts. Use the " +
      "Claude Code local scan instead — it reports the same real token counts.",
    transport: "api",
    inputConvention: "disjoint",
    reportsGeo: false,
    status: "unreadable",
  },
  {
    kind: "chatgpt_personal",
    vendor: "openai",
    label: "ChatGPT Plus / Pro personal",
    description:
      "Individual ChatGPT subscriptions expose no usage API. Use the Codex CLI local scan, which " +
      "reports real per-turn token counts on any plan.",
    transport: "api",
    inputConvention: "inclusive",
    reportsGeo: false,
    status: "unreadable",
  },
  {
    kind: "claude_enterprise",
    vendor: "anthropic",
    label: "Claude Enterprise analytics",
    description:
      "For claude.ai Enterprise organizations, which have no Console admin key. Not yet built.",
    transport: "api",
    inputConvention: "disjoint",
    reportsGeo: false,
    credentialHelp: "https://support.anthropic.com/en/articles/9797531-usage-analytics",
    status: "planned",
  },
];

export function providerSpec(kind: SourceKind): ProviderSpec {
  const spec = PROVIDERS.find((p) => p.kind === kind);
  if (!spec) throw new Error(`unknown source kind "${kind}"`);
  return spec;
}

export function providersByVendor(vendor: VendorId): readonly ProviderSpec[] {
  return PROVIDERS.filter((p) => p.vendor === vendor);
}

/** Sources that need no credential — what the wizard can enable unattended. */
export function localProviders(): readonly ProviderSpec[] {
  return PROVIDERS.filter((p) => p.transport === "local" && p.status === "available");
}

export const VENDOR_LABELS: Record<VendorId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  meta: "Meta",
  qwen: "Qwen",
  moonshot: "Moonshot",
  zai: "Z.ai",
  cohere: "Cohere",
  amazon: "Amazon",
  microsoft: "Microsoft",
  openrouter: "OpenRouter",
  other: "Other",
};

/**
 * Which vendor served a model, from its name.
 *
 * Used to group the dashboard by vendor when records come from a source that
 * covers several — a CSV export, most obviously. Falls back to `other` rather
 * than guessing, because an unrecognised model already falls back to the
 * `average` data-centre preset and pretending to know better would be worse.
 */
export function vendorFromModel(model: string): VendorId {
  const name = model.toLowerCase();
  // Ordered most-specific first: `openai/gpt-4o` and `anthropic.claude-…` both
  // occur in the wild, as do Bedrock and Vertex prefixes.
  if (/claude/.test(name)) return "anthropic";
  if (/^(gpt|o[134][-.]|o[134]$|codex|davinci|text-embedding)/.test(name) || /openai/.test(name)) {
    return "openai";
  }
  if (/gemini|gemma|palm|bison/.test(name)) return "google";
  if (/grok/.test(name)) return "xai";
  if (/mistral|mixtral|ministral|magistral|devstral|codestral|pixtral/.test(name)) return "mistral";
  if (/deepseek/.test(name)) return "deepseek";
  if (/llama|codellama/.test(name)) return "meta";
  if (/qwen|qwq/.test(name)) return "qwen";
  if (/kimi|moonshot/.test(name)) return "moonshot";
  if (/glm|zhipu|z-ai/.test(name)) return "zai";
  if (/command-|cohere/.test(name)) return "cohere";
  if (/titan|nova-(micro|lite|pro|premier)/.test(name)) return "amazon";
  if (/phi-\d/.test(name)) return "microsoft";
  // Deliberately last and deliberately `other`: an unrecognised model already
  // falls back to the `average` data-centre preset in soif's registry, and
  // pretending to know its vendor here would imply a precision that is absent.
  return "other";
}
