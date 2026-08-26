import { closeDatabase, getDatabase } from "@/lib/db/client";
import { Repository, type SourceRow, type UsageRecordRow } from "@/lib/db/repository";
import { loadFactors } from "@/lib/soif/factors";
import {
  estimateAll,
  estimateGrouped,
  litresPerMillionOutputTokens,
  type AggregateTotals,
} from "@/lib/pipeline/estimate-records";
import {
  describeSpread,
  formatEnergy,
  formatTokens,
  formatWater,
  showersEquivalent,
} from "@/lib/format";
import { VesselLadder } from "@/components/VesselLadder";
import { WaterChart, type ChartPoint } from "@/components/WaterChart";
import {
  EmbodiedToggle,
  ModelBars,
  RangeToggle,
  RankedBars,
  SERIES_COLORS,
  SplitStack,
  type RankedDatum,
} from "@/components/Panels";
import {
  PROVIDERS,
  VENDOR_LABELS,
  vendorFromModel,
  type ProviderSpec,
  type VendorId,
} from "@/lib/sources/providers";

/**
 * The dashboard.
 *
 * A server component: it reads usage records, recomputes estimates from raw
 * token counts under the current factor set, and renders. Estimates are never
 * read back from storage as finished millilitres, which is what keeps a
 * factor-set upgrade able to re-derive the whole history.
 *
 * Honesty rules enforced here rather than left to the reader:
 *   1. every figure shows its band (the hero range line, the chart tooltip,
 *      the detail table);
 *   2. the factor-set version is stamped on the page;
 *   3. sources that genuinely cannot be read say so and point at the local scan.
 */

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function rangeStart(range: string): string | undefined {
  const now = new Date();
  const days = { "30d": 30, "3m": 91, "12m": 365 }[range];
  if (!days) return undefined;
  const start = new Date(now.getTime() - days * 86_400_000);
  return start.toISOString().slice(0, 10);
}

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;
  const range = typeof params.range === "string" ? params.range : "all";
  const includeEmbodied = params.embodied !== "0";

  const factors = loadFactors();
  const handle = await getDatabase();
  const repository = new Repository(handle);

  let records: UsageRecordRow[] = [];
  let sources: SourceRow[] = [];
  let lastRuns: Awaited<ReturnType<Repository["recentSyncRuns"]>> = [];
  let ready = true;

  try {
    records = await repository.listUsageRecords({ from: rangeStart(range) });
    sources = await repository.listSources();
    lastRuns = await repository.recentSyncRuns(5);
  } catch {
    // A fresh checkout has no schema yet. Rendering the setup path is more
    // useful than a stack trace, and far more useful than an empty dashboard
    // that looks like "you have used no water".
    ready = false;
  }

  if (!ready || records.length === 0) {
    await closeDatabase();
    return <EmptyState ready={ready} factorsVersion={factors.factors_version} />;
  }

  const options = { includeEmbodied };
  const { totals } = estimateAll(records, factors, options);
  const byDay = estimateGrouped(records, (r) => r.dayKey, factors, options);
  const byModel = estimateGrouped(records, (r) => r.model, factors, options);

  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  // Daily points below ~90 days, monthly above, so the axis stays readable at
  // lifetime range without dropping data.
  const points: ChartPoint[] = days.length > 90 ? toMonthly(days) : toDaily(days);

  const models: RankedDatum[] = [...byModel.entries()]
    .map(([name, group], i) => ({
      name,
      ml: group.totalMl.mid,
      outputTokens: group.outputTokens,
      cachedTokens: group.cachedTokens,
      color: SERIES_COLORS[i % SERIES_COLORS.length]!,
    }))
    .sort((a, b) => b.ml - a.ml)
    .slice(0, 6);

  // Provider breakdown. Derived from the model name rather than stored, so it
  // can never drift from soif's own registry — which is what decides the
  // data-centre preset (Azure vs AWS vs GCP) and therefore the water intensity.
  const byVendor = estimateGrouped(records, (r) => vendorFromModel(r.model), factors, options);
  const providers: RankedDatum[] = [...byVendor.entries()]
    .map(([vendor, group], i) => ({
      name: VENDOR_LABELS[vendor as VendorId] ?? vendor,
      ml: group.totalMl.mid,
      outputTokens: group.outputTokens,
      cachedTokens: group.cachedTokens,
      color: SERIES_COLORS[i % SERIES_COLORS.length]!,
    }))
    .sort((a, b) => b.ml - a.ml);

  // Project breakdown, from the working directory each call was made in.
  // Records predating the project column, and API sources that have no notion
  // of one, are grouped honestly as unattributed rather than dropped.
  const byProject = estimateGrouped(records, (r) => r.project ?? "\u0000unattributed", factors, options);
  const projects: RankedDatum[] = [...byProject.entries()]
    .map(([path, group], i) => ({
      name: path === "\u0000unattributed" ? "Not attributed" : projectLabel(path),
      title: path === "\u0000unattributed" ? "Records from sources with no project context" : path,
      ml: group.totalMl.mid,
      outputTokens: group.outputTokens,
      cachedTokens: group.cachedTokens,
      color: SERIES_COLORS[i % SERIES_COLORS.length]!,
    }))
    .sort((a, b) => b.ml - a.ml)
    .slice(0, 8);

  const splits = [
    { name: "Off-site — power generation", ml: totals.offsiteMl.mid, color: "var(--seq-3)" },
    { name: "Embodied — chips & buildings", ml: totals.embodiedMl.mid, color: "var(--seq-2)" },
    { name: "On-site — cooling towers", ml: totals.onsiteMl.mid, color: "var(--seq-1)" },
  ].filter((part) => part.ml > 0);

  const intensity = litresPerMillionOutputTokens(totals);
  const lever = biggestLever(byModel, factors.registry.models);
  const spread = describeSpread(totals.totalMl);
  const configuredKinds = new Set(sources.map((s) => s.kind));
  const lastRun = lastRuns[0];
  const geoKnown = records.some(
    (r) => r.inferenceGeo && r.inferenceGeo !== "not_available",
  );

  await closeDatabase();

  const [heroValue, heroUnit] = splitMeasure(formatWater(totals.totalMl.mid));

  return (
    <>
      <div className="top">
        <div className="top-in">
          <div className="brand">
            <svg width="17" height="21" viewBox="0 0 24 30" aria-hidden="true">
              <path d="M12 0C12 0 2 12.6 2 19a10 10 0 0 0 20 0C22 12.6 12 0 12 0z" fill="var(--water)" />
            </svg>
            soif <span>water ledger</span>
          </div>
          <div className="spacer" />
          <div className="chip">
            <span className={`dot${lastRun?.status === "error" ? " stale" : ""}`} />
            {describeSources(sources)}
          </div>
          <EmbodiedToggle included={includeEmbodied} />
          <RangeToggle current={range} />
        </div>
      </div>

      <div className="wrap">
        {!includeEmbodied && (
          <div className="notice">
            <span aria-hidden="true">💧</span>
            <div>
              <b>Operational water only.</b> Embodied water from chip fabrication and
              data-center construction is excluded. This is the scope of Google&apos;s published
              per-prompt figures, and the only basis on which a comparison against them means
              anything.
            </div>
          </div>
        )}

        <section className="hero">
          <div>
            <div className="hero-num">
              {heroValue}
              <small>{heroUnit}</small>
            </div>
            <p className="hero-lead">
              of freshwater consumed to serve your AI, across {days.length}{" "}
              {days.length === 1 ? "day" : "days"} and {totals.calls.toLocaleString("en-US")}{" "}
              calls.
            </p>
            <div className="hero-range mono">
              range {formatWater(totals.totalMl.low)} – {formatWater(totals.totalMl.high)} · mid
              scenario shown
            </div>
            {lever && (
              <div className="lever">
                <div className="lever-k">Biggest lever</div>
                <p>
                  <b>{formatWater(lever.savedMl)}</b> of this — {lever.sharePct}% of the total —
                  is the premium for running <span className="mono">{lever.from}</span> where{" "}
                  <span className="mono">{lever.to}</span> would have answered. Same tokens, one
                  tier down.
                </p>
              </div>
            )}
          </div>
          <VesselLadder totalMl={totals.totalMl.mid} />
        </section>

        <div className="row k4">
          <div className="card tile">
            <div className="lab">Latest day</div>
            <div className="val">{withUnit(formatWater(days.at(-1)?.[1].totalMl.mid ?? 0))}</div>
            <div className="foot">{days.at(-1)?.[0] ?? "—"}</div>
          </div>
          <div className="card tile">
            <div className="lab">Energy drawn</div>
            <div className="val">{withUnit(formatEnergy(totals.energyFacilityWh.mid))}</div>
            <div className="foot">at the meter, incl. PUE</div>
          </div>
          <div className="card tile">
            <div className="lab">Per 1M output tokens</div>
            <div className="val">
              {intensity ? withUnit(`${intensity.mid.toFixed(1)} L`) : "—"}
            </div>
            <div className="foot">your blended intensity</div>
          </div>
          <div className="card tile">
            <div className="lab">Equivalent to</div>
            <div className="val">
              {showersEquivalent(totals.totalMl.mid).toFixed(1)}
              <em>showers</em>
            </div>
            <div className="foot">at 45 L per 8-minute shower, mid only</div>
          </div>
        </div>

        <section className="sec">
          <h2>Water over time</h2>
          <p className="lede">
            {points.length > 0 && points[0]!.label !== points.at(-1)!.label
              ? `${points[0]!.label} – ${points.at(-1)!.label}, mid scenario.`
              : "Mid scenario."}
          </p>
          <div className="card" style={{ marginTop: 12 }}>
            <WaterChart points={points} />
            <p className="cap">
              Bars are daily consumption; the line is the running total on the right-hand axis.
              Every bar carries a wide range
              {spread ? ` — this account's uncertainty spans roughly ${spread} the mid line` : ""},
              driven by unknown per-token energy and grid mix. Hover any bar for its band.
            </p>
          </div>
        </section>

        <div className="row k2">
          <div className="card">
            <h3>Which models drank it</h3>
            <p className="sub">Total by model, mid scenario.</p>
            <ModelBars models={models} />
          </div>
          <div className="card">
            <h3>Where the water goes</h3>
            <p className="sub">Not all of it evaporates in a cooling tower.</p>
            <SplitStack parts={splits} />
          </div>
        </div>

        <div className="row k2">
          <div className="card">
            <h3>Which projects drank it</h3>
            <p className="sub">
              By the working directory each call was made in.
              {projects.length === 8 ? " Top 8." : ""}
            </p>
            <RankedBars
              items={projects}
              empty="No project information in this range. Local scans record it; API sources have none."
            />
          </div>
          <div className="card">
            <h3>Which providers drank it</h3>
            <p className="sub">
              Water intensity differs by where a model is served — Azure, AWS and Google&apos;s fleet
              report WUE figures that span roughly 6x.
            </p>
            <RankedBars items={providers} empty="No provider usage in this range." />
          </div>
        </div>

        <section className="sec">
          <h2>Connected sources</h2>
          <p className="lede">
            The dashboard is only as honest as its inputs — here is exactly where these numbers
            came from.
          </p>
          <div className="card" style={{ marginTop: 12 }}>
            <div className="src">
              {PROVIDERS.map((provider) => (
                <SourceCard
                  key={provider.kind}
                  provider={provider}
                  active={configuredKinds.has(provider.kind)}
                />
              ))}
              <div className="s-item">
                <div className="s-top">
                  <h4>Inference geography</h4>
                  <span className={`pill ${geoKnown ? "y" : "idle"}`}>
                    {geoKnown ? "Reported" : "Not available"}
                  </span>
                </div>
                <p>
                  {geoKnown
                    ? "Real routing is reported, so grid water intensity is measured rather than assumed."
                    : "This data reports no inference geography, so each model's region falls back to its registry default rather than being guessed."}
                </p>
              </div>
            </div>
          </div>
        </section>

        <details>
          <summary>Show the underlying numbers</summary>
          <div className="card tblwrap" style={{ marginTop: 11 }}>
            <table>
              <thead>
                <tr>
                  <th>{points.length > 90 ? "Month" : "Day"}</th>
                  <th>Water (mid)</th>
                  <th>Low</th>
                  <th>High</th>
                  <th>Energy</th>
                  <th>Output tokens</th>
                  <th>Cached tokens</th>
                </tr>
              </thead>
              <tbody>
                {days
                  .slice()
                  .reverse()
                  .map(([day, group]) => (
                    <tr key={day}>
                      <td>{day}</td>
                      <td>{formatWater(group.totalMl.mid)}</td>
                      <td>{formatWater(group.totalMl.low)}</td>
                      <td>{formatWater(group.totalMl.high)}</td>
                      <td>{formatEnergy(group.energyFacilityWh.mid)}</td>
                      <td>{formatTokens(group.outputTokens)}</td>
                      <td>{formatTokens(group.cachedTokens)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>

        <footer>
          Estimates, not measurements — produced by{" "}
          <a href="https://github.com/Unchained-Labs/soif">soif</a> under factor set{" "}
          <span className="mono">{factors.factors_version}</span>, following the
          operational-water method of Ren et al.
          {includeEmbodied ? " plus an embodied adder." : " with embodied water excluded."} Ranges
          are scenario spreads, not confidence intervals. Water is location-based: renewable
          certificates do not un-evaporate water from the local grid.
        </footer>
      </div>
    </>
  );
}

/**
 * How well an adapter is actually proven.
 *
 * Shown rather than hidden because "supported" means something very different
 * for a reader that has been run against a real corpus than for one built from
 * a published schema. An adapter that silently reads zeros is indistinguishable
 * from a provider you did not use, so the confidence travels with the claim.
 */
const VERIFICATION_LABELS: Record<string, string> = {
  "real-corpus": "Verified against real usage",
  "vendor-source": "Built from the tool's own source",
  "fixture-only": "Built from published schema, tested against fixtures",
};

function SourceCard({ provider, active }: { provider: ProviderSpec; active: boolean }) {
  const state: "on" | "off" | "idle" =
    provider.status === "unreadable" ? "off" : provider.status === "planned" ? "idle" : active ? "on" : "idle";
  const label =
    provider.status === "unreadable"
      ? "No public API"
      : provider.status === "planned"
        ? "Not built yet"
        : active
          ? "Active"
          : provider.transport === "local"
            ? "Available"
            : "Not configured";

  return (
    <div className="s-item">
      <div className="s-top">
        <h4>{provider.label}</h4>
        <span className={`pill ${state === "on" ? "y" : state === "off" ? "n" : "idle"}`}>
          {label}
        </span>
      </div>
      <p>{provider.description}</p>
      {provider.verification && (
        <p className="s-note">
          {VERIFICATION_LABELS[provider.verification] ?? provider.verification}
          {provider.verifiedFrom ? ` — ${provider.verifiedFrom}` : ""}
        </p>
      )}
    </div>
  );
}

function EmptyState({ ready, factorsVersion }: { ready: boolean; factorsVersion: string }) {
  return (
    <>
      <div className="top">
        <div className="top-in">
          <div className="brand">
            <svg width="17" height="21" viewBox="0 0 24 30" aria-hidden="true">
              <path d="M12 0C12 0 2 12.6 2 19a10 10 0 0 0 20 0C22 12.6 12 0 12 0z" fill="var(--water)" />
            </svg>
            soif <span>water ledger</span>
          </div>
        </div>
      </div>
      <div className="wrap">
        <div className="empty">
          <h2>{ready ? "No usage recorded yet" : "Database not initialised"}</h2>
          <p>
            {ready
              ? "Nothing has been ingested. The local scan reads Claude Code transcripts on this machine — it works on any plan, needs no credential, and the data never leaves the box."
              : "The schema has not been created yet. Run the migration, then scan."}
          </p>
          <pre>
            {ready
              ? "npx soif-scan"
              : "npm run db:migrate\nnpx soif-scan"}
          </pre>
          <p style={{ marginTop: 18, fontSize: 13 }}>
            For an organization, add an Anthropic admin key to pull real token counts from the
            Usage API. Personal Pro/Max subscriptions have no usage API — the local scan is the
            honest path there.
          </p>
        </div>
        <footer>
          soif factor set <span className="mono">{factorsVersion}</span> · estimates, not
          measurements.
        </footer>
      </div>
    </>
  );
}

// -- helpers ----------------------------------------------------------------

function toDaily(days: Array<[string, AggregateTotals]>): ChartPoint[] {
  return days.map(([day, group]) => ({
    key: day,
    label: day.slice(5),
    low: group.totalMl.low,
    mid: group.totalMl.mid,
    high: group.totalMl.high,
  }));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function toMonthly(days: Array<[string, AggregateTotals]>): ChartPoint[] {
  const months = new Map<string, { low: number; mid: number; high: number }>();
  for (const [day, group] of days) {
    const key = day.slice(0, 7);
    const acc = months.get(key) ?? { low: 0, mid: 0, high: 0 };
    months.set(key, {
      low: acc.low + group.totalMl.low,
      mid: acc.mid + group.totalMl.mid,
      high: acc.high + group.totalMl.high,
    });
  }
  return [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const [year, month] = key.split("-");
      return { key, label: `${MONTHS[Number(month) - 1]} ${year!.slice(2)}`, ...value };
    });
}

/**
 * The cheapest real saving available: usage on a heavy model where a lighter
 * sibling was already answering the same kind of work.
 *
 * This is the one figure on the page derived from a counterfactual rather than
 * measured, so it is deliberately hard to satisfy:
 *
 *  - **Same vendor only.** Comparing `claude-opus` against `gemini-2.5-pro`
 *    conflates a model-tier difference with a data-centre one — Google's fleet
 *    WUE is ~6x AWS's — so the "saving" would be mostly geography, not choice.
 *  - **The lighter model needs real usage.** Deriving an intensity from a
 *    handful of calls and then projecting it across millions of tokens produces
 *    a confident number from almost no evidence. It once claimed 67% of total
 *    water against a model with 42 mL of usage.
 *  - **Returns null when there is nothing to say.** A dashboard that always
 *    finds a lever is one that will eventually invent one.
 */
function biggestLever(
  byModel: Map<string, AggregateTotals>,
  registry: ReadonlyArray<{ match: string; tier: string }>,
): { from: string; to: string; savedMl: number; sharePct: string } | null {
  const total = [...byModel.values()].reduce((sum, g) => sum + g.totalMl.mid, 0);
  const totalOutput = [...byModel.values()].reduce((sum, g) => sum + g.outputTokens, 0);
  if (total <= 0 || totalOutput <= 0) return null;

  const tierRank = new Map(["nano", "small", "medium", "large", "frontier"].map((t, i) => [t, i]));
  const tierOf = (model: string) => {
    const normalised = model.toLowerCase();
    let best: { match: string; tier: string } | null = null;
    for (const entry of registry) {
      if (normalised.includes(entry.match.toLowerCase()) && (!best || entry.match.length > best.match.length)) {
        best = entry;
      }
    }
    return best?.tier ?? null;
  };

  /** A lighter model needs at least this share of output tokens to be evidence. */
  const MIN_SHARE = 0.01;

  const used = [...byModel.entries()]
    .map(([name, group]) => ({
      name,
      group,
      rank: tierRank.get(tierOf(name) ?? "") ?? -1,
      vendor: vendorFromModel(name),
      intensity: group.outputTokens > 0 ? group.totalMl.mid / group.outputTokens : 0,
    }))
    .filter((m) => m.rank >= 0 && m.intensity > 0);
  if (used.length < 2) return null;

  const heaviest = used.reduce((a, b) => (b.group.totalMl.mid > a.group.totalMl.mid ? b : a));

  // Same vendor, lighter tier, and enough usage of its own to mean something.
  const candidates = used
    .filter(
      (m) =>
        m.vendor === heaviest.vendor &&
        m.rank < heaviest.rank &&
        m.group.outputTokens / totalOutput >= MIN_SHARE &&
        m.intensity < heaviest.intensity,
    )
    .sort((a, b) => b.rank - a.rank);

  const lighter = candidates[0];
  if (!lighter) return null;

  const savedMl = (heaviest.intensity - lighter.intensity) * heaviest.group.outputTokens;
  if (savedMl <= 0) return null;

  return {
    from: heaviest.name,
    to: lighter.name,
    savedMl,
    sharePct: ((savedMl / total) * 100).toFixed(0),
  };
}

/**
 * The header chip: what this page is actually reading from.
 *
 * Names the account when one is known rather than a generic "connected", so a
 * multi-account machine cannot present one account's water as another's.
 */
function describeSources(sources: SourceRow[]): string {
  if (sources.length === 0) return "no sources";

  const labels = sources
    .map((source) => {
      const account = source.account ?? {};
      const org = typeof account.organizationName === "string" ? account.organizationName : null;
      const email = typeof account.emailAddress === "string" ? account.emailAddress : null;
      return org ?? email ?? SOURCE_KIND_LABELS[source.kind] ?? source.kind;
    })
    .filter((label, index, all) => all.indexOf(label) === index);

  return labels.length <= 2 ? labels.join(" · ") : `${labels[0]} +${labels.length - 1} more`;
}

const SOURCE_KIND_LABELS: Record<string, string> = {
  claude_code_local: "local scan",
  codex_local: "Codex",
  anthropic_admin: "Anthropic Admin API",
  openai_admin: "OpenAI org usage",
  claude_enterprise: "Claude Enterprise",
  csv: "CSV import",
};

/**
 * Shorten a working directory to something readable in a bar label.
 *
 * The last two path segments are usually enough to identify a project while
 * staying distinguishable — `dev/soif-app` rather than the whole home path —
 * and the full path stays available on hover.
 */
function projectLabel(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) return path;
  return parts.slice(-2).join("/");
}

/** Split "531 L" into ["531", "L"] so the unit can be styled down. */
function splitMeasure(text: string): [string, string] {
  const index = text.lastIndexOf(" ");
  return index === -1 ? [text, ""] : [text.slice(0, index), text.slice(index + 1)];
}

function withUnit(text: string) {
  const [value, unit] = splitMeasure(text);
  return (
    <>
      {value}
      <em>{unit}</em>
    </>
  );
}
