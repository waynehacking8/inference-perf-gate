import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, compare, pctChange, renderMarkdown } from "../src/compare.ts";

test("pctChange basics", () => {
  assert.equal(pctChange(100, 110), 10);
  assert.equal(pctChange(100, 90), -10);
  assert.equal(pctChange(0, 0), 0);
  assert.equal(pctChange(0, 5), Infinity);
});

test("higher_is_better: a drop beyond tolerance regresses", () => {
  const spec = { direction: "higher_is_better" as const, tolerance_pct: 2 };
  assert.equal(classify(27700, 25000, spec).verdict, "regression"); // throughput dropped
  assert.equal(classify(27700, 30000, spec).verdict, "improvement");
  assert.equal(classify(27700, 27800, spec).verdict, "neutral"); // within 2%
});

test("lower_is_better: a rise beyond tolerance regresses", () => {
  const spec = { direction: "lower_is_better" as const, tolerance_pct: 3 };
  assert.equal(classify(10, 12, spec).verdict, "regression"); // p99 latency rose
  assert.equal(classify(10, 8, spec).verdict, "improvement");
  assert.equal(classify(10, 10.2, spec).verdict, "neutral"); // within 3%
});

test("new and missing metrics never throw", () => {
  const spec = { direction: "higher_is_better" as const, tolerance_pct: 2 };
  assert.equal(classify(null, 5, spec).verdict, "new");
  assert.equal(classify(5, null, spec).verdict, "missing");
});

test("only specced metrics can gate the build", () => {
  const baseline = { tokens_per_sec: 27700, unlisted_metric: 100 };
  const current = { tokens_per_sec: 24000, unlisted_metric: 1 }; // both dropped hard
  const specs = { tokens_per_sec: { direction: "higher_is_better" as const, tolerance_pct: 2 } };
  const report = compare(baseline, current, specs);
  assert.equal(report.verdict, "regressed");
  assert.equal(report.regressions, 1); // unlisted_metric did NOT count
});

test("clean run passes and renders a table", () => {
  const baseline = { pct_of_cublas: 106, decode_p99_ms: 10 };
  const current = { pct_of_cublas: 106.5, decode_p99_ms: 9.8 };
  const specs = {
    pct_of_cublas: { direction: "higher_is_better" as const, tolerance_pct: 1 },
    decode_p99_ms: { direction: "lower_is_better" as const, tolerance_pct: 3 },
  };
  const report = compare(baseline, current, specs);
  assert.equal(report.verdict, "pass");
  assert.equal(report.regressions, 0);
  const md = renderMarkdown(report);
  assert.match(md, /no regressions/);
  assert.match(md, /pct_of_cublas/);
});
