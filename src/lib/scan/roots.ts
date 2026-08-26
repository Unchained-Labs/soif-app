import { homedir } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * Finding the transcript roots to scan.
 *
 * This is also the multi-account surface. Claude Code keeps one config
 * directory per account when you drive it with `CLAUDE_CONFIG_DIR`, so
 * "usage across accounts" is really "usage across config roots" — discover
 * them, scan each, and attribute rows to the account each root belongs to.
 *
 * What this deliberately does not do: read the credential store. CodexBar
 * (which pioneered the cross-account read on macOS) will not touch Claude's
 * keychain entry either — it shells out to an external `claude-swap` binary and
 * lets that own the credential transaction. Here the account label comes from
 * the non-secret `oauthAccount` block in `.claude.json`, and nothing reads a
 * token. A dashboard holding an org admin key has no business also holding
 * someone's session credentials.
 */

/** Roots are searched in this order; earlier entries win on duplicate paths. */
export interface ScanRoot {
  /** Absolute path to a `projects/` directory containing `*.jsonl` transcripts. */
  path: string;
  /** The config directory this root belongs to (its parent). */
  configDir: string;
  /** Where it came from, for the UI to explain what it scanned. */
  origin: "CLAUDE_CONFIG_DIR" | "default" | "xdg" | "explicit";
  /** Non-secret account label from `.claude.json`, when present. */
  account?: AccountIdentity;
}

export interface AccountIdentity {
  /** Anthropic account uuid — stable, and not a credential. */
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  organizationName?: string;
}

export interface DiscoverOptions {
  /** Loose on purpose: callers pass partial environments, and requiring the
   * full NodeJS.ProcessEnv shape would force every test to invent a NODE_ENV. */
  env?: Record<string, string | undefined>;
  home?: string;
  /** Explicit roots, e.g. from `--root`. When given, discovery is skipped. */
  explicit?: readonly string[];
}

/**
 * Discover every Claude Code transcript root on this machine.
 *
 * `CLAUDE_CONFIG_DIR` may hold a list separated by the platform path delimiter,
 * which is how one machine drives several accounts.
 */
export async function discoverRoots(options: DiscoverOptions = {}): Promise<ScanRoot[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();

  const candidates: Array<{ configDir: string; origin: ScanRoot["origin"] }> = [];

  if (options.explicit && options.explicit.length > 0) {
    for (const path of options.explicit) {
      // An explicit path may point at either the config dir or the projects
      // dir; accept both so `--root ~/.claude` does the obvious thing.
      const abs = resolve(expandTilde(path, home));
      candidates.push({
        configDir: abs.endsWith(`${sep}projects`) ? abs.slice(0, -`${sep}projects`.length) : abs,
        origin: "explicit",
      });
    }
  } else {
    const configured = env.CLAUDE_CONFIG_DIR?.trim();
    if (configured) {
      for (const part of configured.split(process.platform === "win32" ? ";" : ":")) {
        const trimmed = part.trim();
        if (trimmed) {
          candidates.push({ configDir: resolve(expandTilde(trimmed, home)), origin: "CLAUDE_CONFIG_DIR" });
        }
      }
    }
    // Always probe the defaults too, even when CLAUDE_CONFIG_DIR is set — an
    // operator who added a second account still has history under the first.
    candidates.push({ configDir: join(home, ".claude"), origin: "default" });
    candidates.push({ configDir: join(home, ".config", "claude"), origin: "xdg" });
    const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
    if (xdgConfigHome) {
      candidates.push({ configDir: join(resolve(expandTilde(xdgConfigHome, home)), "claude"), origin: "xdg" });
    }
  }

  const seen = new Set<string>();
  const roots: ScanRoot[] = [];

  for (const candidate of candidates) {
    const projects = join(candidate.configDir, "projects");
    if (seen.has(projects)) continue;
    seen.add(projects);
    if (!(await isDirectory(projects))) continue;
    roots.push({
      path: projects,
      configDir: candidate.configDir,
      origin: candidate.origin,
      account: await readAccountIdentity(candidate.configDir),
    });
  }

  return roots;
}

/**
 * Read the non-secret account identity from `<configDir>/.claude.json`.
 *
 * That file also contains history and settings; only the `oauthAccount` label
 * fields are lifted, and never a token. Returns undefined rather than throwing —
 * an unreadable or absent file just means the rows are unattributed.
 */
export async function readAccountIdentity(configDir: string): Promise<AccountIdentity | undefined> {
  for (const candidate of [join(configDir, ".claude.json"), join(configDir, "claude.json")]) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as { oauthAccount?: Record<string, unknown> };
      const account = parsed.oauthAccount;
      if (!account) continue;
      const identity: AccountIdentity = {
        accountUuid: asString(account.accountUuid),
        emailAddress: asString(account.emailAddress),
        organizationUuid: asString(account.organizationUuid),
        organizationName: asString(account.organizationName),
      };
      return Object.values(identity).some(Boolean) ? identity : undefined;
    } catch {
      // Missing, unreadable, or not JSON — all equivalent here.
    }
  }
  return undefined;
}

/** Every `*.jsonl` transcript under a root, recursively. */
export async function listTranscripts(rootPath: string): Promise<string[]> {
  const out: string[] = [];
  await walk(rootPath, out);
  out.sort();
  return out;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // Permission denied or raced deletion: skip rather than abort the scan.
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith(`~${sep}`) || path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
