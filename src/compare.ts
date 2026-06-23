/**
 * Core comparison engine for inference-perf-gate.
 *
 * Pure functions, no I/O — so the verdict logic is unit-testable without a runner,
 * a GPU, or the GitHub API. index.ts wires these to @actions/core + the Octokit client.
 */

export type Direction = "higher_is_better" | "lower_is_better";

export interface MetricSpec {
  direction: Direction;
  /** Run-to-run noise floor, in percent. A change within ±tolerance is neutral. */
  tolerance_pct: number;
}

export type MetricSpecMap = Record<string, MetricSpec>;
export type Measurements = Record<string, number>;

export type Verdict = "regression" | "improvement" | "neutral" | "new" | "missing";

export interface MetricResult {
  metric: string;
  baseline: number | null;
  current: number | null;
  /** Signed % change of current vs baseline (direction-agnostic arithmetic). */
  deltaPct: number | null;
  tolerancePct: number;
  direction: Direction;
  verdict: Verdict;
}

export interface CompareReport {
  results: MetricResult[];
  regressions: number;
  improvements: number;
  verdict: "pass" | "regressed";
}

const DEFAULT_SPEC: MetricSpec = { direction: "higher_is_better", tolerance_pct: 2.0 };

/** Signed percentage change of `current` relative to `baseline`. */
export function pctChange(baseline: number, current: number): number {
  if (baseline === 0) return current === 0 ? 0 : Infinity;
  return ((current - baseline) / Math.abs(baseline)) * 100;
}

/**
 * Classify one metric. The sign of `deltaPct` is direction-agnostic (just current vs baseline);
 * whether that sign is *good* depends on the metric's direction.
 */
export function classify(
  baseline: number | null,
  current: number | null,
  spec: MetricSpec,
): { verdict: Verdict; deltaPct: number | null } {
  if (current === null || current === undefined || Number.isNaN(current)) {
    return { verdict: "missing", deltaPct: null };
  }
  if (baseline === null || baseline === undefined || Number.isNaN(baseline)) {
    return { verdict: "new", deltaPct: null };
  }

  const deltaPct = pctChange(baseline, current);

  // Within the noise floor → neutral, regardless of direction.
  if (Math.abs(deltaPct) <= spec.tolerance_pct) {
    return { verdict: "neutral", deltaPct };
  }

  const improvedWhenUp = spec.direction === "higher_is_better";
  const wentUp = deltaPct > 0;
  const improved = wentUp === improvedWhenUp;
  return { verdict: improved ? "improvement" : "regression", deltaPct };
}

/**
 * Compare measured metrics against a baseline. Only metrics present in `specs` can *gate*;
 * metrics outside `specs` are still reported (with DEFAULT_SPEC) but never fail the build,
 * matching the README contract ("unlisted metrics are reported but never gate").
 */
export function compare(
  baseline: Measurements,
  current: Measurements,
  specs: MetricSpecMap,
): CompareReport {
  const metrics = Array.from(
    new Set([...Object.keys(baseline), ...Object.keys(current), ...Object.keys(specs)]),
  ).sort();

  const results: MetricResult[] = [];
  let regressions = 0;
  let improvements = 0;

  for (const metric of metrics) {
    const gated = metric in specs;
    const spec = specs[metric] ?? DEFAULT_SPEC;
    const b = metric in baseline ? baseline[metric] : null;
    const c = metric in current ? current[metric] : null;
    const { verdict, deltaPct } = classify(b, c, spec);

    // Only a specced metric can gate. The row keeps its true verdict either way;
    // a non-gated regression shows 🔴 but never increments the counter.
    if (verdict === "regression" && gated) regressions++;
    if (verdict === "improvement") improvements++;

    results.push({
      metric,
      baseline: b,
      current: c,
      deltaPct,
      tolerancePct: spec.tolerance_pct,
      direction: spec.direction,
      verdict,
    });
  }

  return {
    results,
    regressions,
    improvements,
    verdict: regressions > 0 ? "regressed" : "pass",
  };
}

const ICON: Record<Verdict, string> = {
  regression: "🔴",
  improvement: "🟢",
  neutral: "⚪",
  new: "🆕",
  missing: "❓",
};

function fmt(n: number | null): string {
  if (n === null) return "—";
  if (!Number.isFinite(n)) return "∞";
  return Math.abs(n) >= 100 ? n.toFixed(1) : n.toPrecision(4).replace(/\.?0+$/, "");
}

function fmtDelta(n: number | null): string {
  if (n === null) return "—";
  if (!Number.isFinite(n)) return "∞";
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(2)}%`;
}

/** Render the comparison as a GitHub-flavored markdown table + summary line. */
export function renderMarkdown(report: CompareReport): string {
  const header =
    report.verdict === "regressed"
      ? `### ❌ inference-perf-gate — ${report.regressions} regression${report.regressions === 1 ? "" : "s"}`
      : `### ✅ inference-perf-gate — no regressions`;

  const rows = report.results.map((r) => {
    const dir = r.direction === "higher_is_better" ? "↑ better" : "↓ better";
    return `| ${ICON[r.verdict]} ${r.metric} | ${fmt(r.baseline)} | ${fmt(r.current)} | ${fmtDelta(
      r.deltaPct,
    )} | ±${r.tolerancePct}% | ${dir} |`;
  });

  return [
    header,
    "",
    "| metric | baseline | current | Δ | tol | dir |",
    "|---|---:|---:|---:|---:|:--|",
    ...rows,
    "",
    `🟢 ${report.improvements} improved · 🔴 ${report.regressions} regressed · ` +
      `${report.results.length} metrics total`,
    "",
    "_Tolerance is the per-metric run-to-run noise floor; a Δ inside it is neutral._",
  ].join("\n");
}
