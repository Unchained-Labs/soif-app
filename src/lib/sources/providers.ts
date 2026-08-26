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

export type VendorId = "anthropic" | "openai" | "google" | "xai" | "mistral" | "deepseek" | "other";

/** How a source gets its data. */
export type SourceKind =
  | "claude_code_local"
  | "codex_local"
  | "anthropic_admin"
  | "openai_admin"
  | "claude_enterprise"
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
  /** Implemented and wired, or declared but not yet available. */
  status: "available" | "planned";
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
  if (/claude/.test(name)) return "anthropic";
  if (/^(gpt|o[134]|codex|davinci|text-embedding)/.test(name) || /openai/.test(name)) return "openai";
  if (/gemini|gemma|palm|bison/.test(name)) return "google";
  if (/grok/.test(name)) return "xai";
  if (/mistral|mixtral|ministral|magistral|devstral/.test(name)) return "mistral";
  if (/deepseek/.test(name)) return "deepseek";
  return "other";
}
