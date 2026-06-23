/**
 * inference-perf-gate entrypoint: read baseline + measured results, diff them, post a PR
 * comment, set outputs, and (optionally) hard-fail on regression.
 *
 * All metric logic lives in compare.ts (pure + unit-tested). This file is just I/O glue:
 * filesystem, optional benchmark exec, the GitHub API, and @actions/core wiring.
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import * as core from "@actions/core";
import * as github from "@actions/github";
import yaml from "js-yaml";
import { compare, renderMarkdown, type MetricSpecMap, type Measurements } from "./compare.ts";

const COMMENT_MARKER = "<!-- inference-perf-gate -->";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Accept either a flat {metric: number} map or {metrics: {metric: number}}. */
function loadMeasurements(path: string): Measurements {
  const raw = readJson<Record<string, unknown>>(path);
  const flat = (raw.metrics ?? raw) as Record<string, unknown>;
  const out: Measurements = {};
  for (const [k, v] of Object.entries(flat)) {
    if (typeof v === "number") out[k] = v;
  }
  return out;
}

function loadSpecs(path: string): MetricSpecMap {
  if (!path) return {};
  const doc = yaml.load(readFileSync(path, "utf8")) as { metrics?: MetricSpecMap };
  return doc?.metrics ?? {};
}

async function upsertComment(token: string, body: string): Promise<void> {
  const ctx = github.context;
  const pr = ctx.payload.pull_request?.number;
  if (!pr) {
    core.info("Not a pull_request event — skipping PR comment.");
    return;
  }
  const octokit = github.getOctokit(token);
  const { owner, repo } = ctx.repo;
  const existing = await octokit.rest.issues.listComments({ owner, repo, issue_number: pr });
  const mine = existing.data.find((c) => c.body?.includes(COMMENT_MARKER));
  const payload = `${COMMENT_MARKER}\n${body}`;
  if (mine) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body: payload });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: pr, body: payload });
  }
}

async function main(): Promise<void> {
  const resultsPath = core.getInput("results_path") || "results.json";
  const baselinePath = core.getInput("baseline_path") || "baseline.json";
  const metricsPath = core.getInput("metrics_path");
  const benchCmd = core.getInput("benchmark_command");
  const failOnRegression = (core.getInput("fail_on_regression") || "true") === "true";
  const token = core.getInput("github_token");

  if (benchCmd) {
    core.info(`Running benchmark: ${benchCmd}`);
    execSync(benchCmd, { stdio: "inherit" });
  }

  if (!existsSync(resultsPath)) throw new Error(`results not found: ${resultsPath}`);
  if (!existsSync(baselinePath)) throw new Error(`baseline not found: ${baselinePath}`);

  const current = loadMeasurements(resultsPath);
  const baseline = loadMeasurements(baselinePath);
  const specs = loadSpecs(metricsPath);

  const report = compare(baseline, current, specs);
  const md = renderMarkdown(report);
  core.info(md);

  core.setOutput("regressions_count", String(report.regressions));
  core.setOutput("verdict", report.verdict);
  core.setOutput("report_markdown", md);

  if (token) {
    try {
      await upsertComment(token, md);
    } catch (e) {
      core.warning(`Could not post PR comment: ${(e as Error).message}`);
    }
  }

  if (report.verdict === "regressed" && failOnRegression) {
    core.setFailed(`${report.regressions} performance regression(s) beyond tolerance.`);
  }
}

main().catch((e) => core.setFailed((e as Error).message));
